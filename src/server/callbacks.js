var path = require('path'),
    fs = require('fs'),
    settings = require('./settings'),
    osc = require('./osc'),
    {ipc} = require('./server'),
    {deepCopy} = require('./utils'),
    theme = require('./theme')

var widgetHashTable = {},
    clipboard = {clipboard: null, idClipboard: null}

module.exports =  {

    open(data, clientId) {
        // client connected

        ipc.send('connected')

        var recentSessions = settings.read('recentSessions')

        ipc.send('sessionList', recentSessions, clientId)
        ipc.send('clipboard', clipboard, clientId)
        ipc.send('serverTargets', settings.read('send'), clientId)

        if (settings.read('load') && !data.hotReload) return this.sessionOpen({path: settings.read('load')}, clientId)

    },

    close(data, clientId) {
        // client disconnected

        // clear osc data cache
        if (widgetHashTable[clientId]) delete widgetHashTable[clientId]

    },

    clipboard(data, clientId) {
        // shared clipboard

        clipboard = data
        ipc.send('clipboard', data, null, clientId)

    },

    sessionAddToHistory(data) {

        var recentSessions = settings.read('recentSessions')

        fs.lstat(data, (err, stats)=>{

            if (err || !stats.isFile()) return

            // add session to history
            recentSessions.unshift(path.resolve(data))
            // remove doubles from history
            recentSessions = recentSessions.filter(function(elem, index, self) {
                return index == self.indexOf(elem)
            })

            // history size limit
            if (recentSessions.length > 10) recentSessions = recentSessions.slice(0, 10)

            // save history
            settings.write('recentSessions', recentSessions)

            ipc.send('sessionList', recentSessions)

        })
    },

    sessionRemoveFromHistory(data) {

        var recentSessions = settings.read('recentSessions')
        if (recentSessions.indexOf(data) > -1) {
            recentSessions.splice(recentSessions.indexOf(data),1)
            settings.write('recentSessions',recentSessions)
            ipc.send('sessionList', recentSessions)
        }

    },

    sessionSetPath(data, clientId) {
        // store client's current session file path

        if (Array.isArray(data.path)) data.path = path.resolve(...data.path)

        if (!settings.read('read-only')) {
            module.exports.sessionAddToHistory(data.path)
        }

        ipc.clients[clientId].sessionPath = data.path

        ipc.send('setTitle', path.basename(data.path), clientId)

    },

    sessionOpen(data, clientId) {
        // attempt to read session file

        if (Array.isArray(data.path)) data.path = path.resolve(...data.path)

        module.exports.fileRead(data, clientId, true, (result)=>{

            ipc.clients[clientId].sessionPath = data.path // for resolving local file requests
            ipc.send('sessionOpen', {path: data.path, session: result}, clientId)

        })

    },

    sessionOpened(data, clientId) {
        // session file opened successfully

        if (Array.isArray(data.path)) data.path = path.resolve(...data.path)

        if (settings.read('state')) {
            var send = true
            for (var id in ipc.clients) {
                // only make the client send its osc state if there are no other active clients
                if (id !== clientId && ipc.clients[id].connected()) {
                    send = false
                }
            }
            var state = {
                state: JSON.parse(fs.readFileSync(settings.read('state'), 'utf8')),
                send: send
            }
            ipc.send('stateLoad', state, clientId)
        }

        ipc.send('stateSend', null, null, clientId)

        module.exports.sessionSetPath({path: data.path}, clientId)

    },

    fileRead(data, clientId, ok, callback) {
        // private function

        if (!ok) return

        if (Array.isArray(data.path)) data.path = path.resolve(...data.path)

        fs.readFile(data.path, 'utf8', (err, result)=>{

            var error

            if (err) {
                error = err
            } else {
                try {
                    result = JSON.parse(result)
                    callback(result)
                } catch(err) {
                    error = err
                }
            }

            if (error) ipc.send('error', `Could not open file (${error})`)

        })

    },

    fileSave(data, clientId, ok, callback) {
        // private function

        if (!ok) return

        if (!data.path || settings.read('remote-saving') && !RegExp(settings.read('remote-saving')).test(ipc.clients[clientId].address)) {

            return ipc.send('notify', {
                icon: 'save',
                locale: 'remotesave_forbidden',
                class: 'error'
            }, clientId)

        }

        if (data.path) {

            if (Array.isArray(data.path)) data.path = path.resolve(...data.path)

            var root = settings.read('remote-root')
            if (root && !data.path.includes(root)) {
                console.error('(ERROR) Could not save: path outside of remote-root')
                return ipc.send('notify', {
                    class: 'error',
                    locale: 'remotesave_fail',
                    message: ' (Could not save: path outside of remote-root)'
                }, clientId)
            }

            try {
                JSON.parse(data.session)
            } catch(e) {
                return console.error('(ERROR) Could not save: invalid file')
            }

            fs.writeFile(data.path, data.session, function(err, fdata) {

                if (err) return ipc.send('notify', {
                    class: 'error',
                    locale: 'remotesave_fail',
                    message: err
                }, clientId)


                ipc.send('notify', {
                    icon: 'save',
                    locale: 'remotesave_success',
                    message: ' ('+ path.basename(data.path) +')'
                }, clientId)

                callback()

            })

        }

    },

    stateOpen(data, clientId) {
        // attempt to open state file

        if (Array.isArray(data.path)) data.path = path.resolve(...data.path)

        module.exports.fileRead(data, clientId, true, (result)=>{

            ipc.send('stateLoad', {state: result, path: data.path, send: true}, clientId)

        })

    },

    sessionSave(data, clientId) {
        // save session file (.json)

        if (Array.isArray(data.path)) data.path = path.resolve(...data.path)

        if (!path.basename(data.path).match(/.*\.json$/)) return console.error('(ERROR) Sessions must be saved as .json files')

        module.exports.fileSave(data, clientId, true, ()=>{

            console.log('(INFO) Session file saved in '+ data.path)

            ipc.send('sessionSaved', clientId)

            // reload session in other clients
            for (var id in ipc.clients) {
                if (id !== clientId && ipc.clients[id].sessionPath === data.path) {
                    module.exports.sessionOpen({path: data.path}, id)
                }
            }

            module.exports.sessionSetPath({path: data.path}, clientId)

        })

    },

    stateSave(data, clientId) {
        // save state file (.json)

        if (Array.isArray(data.path)) data.path = path.resolve(...data.path)

        if (!path.basename(data.path).match(/.*\.state/)) return console.error('(ERROR) Statesaves must be saved as .state files')

        module.exports.fileSave(data, clientId, true, ()=>{

            console.log('(INFO) State file saved in '+ data.path)

        })

    },

    syncOsc(shortdata, clientId) {
        // sync osc (or midi) message with other clients

        if (!(widgetHashTable[clientId] && widgetHashTable[clientId][shortdata.h])) return

        var value = shortdata.v,
            data = widgetHashTable[clientId][shortdata.h]

        data = deepCopy(data)
        for (var k in shortdata) {
            data[k] = shortdata[k]
        }

        // only rawTarget will be used
        delete data.target

        data.args = data.preArgs ? data.preArgs.concat(value) : [value]

        if (!data.noSync) ipc.send('receiveOsc', data, null, clientId)


    },

    sendOsc(shortdata, clientId) {
        // send osc (or midi) message and sync with other clients

        if (!(widgetHashTable[clientId] && widgetHashTable[clientId][shortdata.h])) return

        var value = shortdata.v,
            data = widgetHashTable[clientId][shortdata.h]

        data = deepCopy(data)
        for (var k in shortdata) {
            data[k] = shortdata[k]
        }

        if (data.target) {

            var targets = []

            if (data.target.indexOf(null) === -1 && settings.read('send') && !shortdata.target) Array.prototype.push.apply(targets, settings.read('send'))
            if (data.target) Array.prototype.push.apply(targets, data.target)

            data.args = data.preArgs ? data.preArgs.concat(value) : [value]

            for (var i in targets) {

                if (targets[i] === 'self') {
                    ipc.send('receiveOsc',data,clientId)
                    continue
                } else if (targets[i] === null) {
                    continue
                }

                var host = targets[i].split(':')[0],
                    port = targets[i].split(':')[1]

                if (port) {

                    osc.send(host, port, data.address, data.args, data.typeTags, clientId)

                }

            }

        }

        if (!data.noSync) ipc.send('receiveOsc', data, null, clientId)

    },

    addWidget(data, clientId) {
        // cache widget osc data to reduce bandwidth usage

        if (!widgetHashTable[clientId])  {
            widgetHashTable[clientId] = {}
        }

        if (!widgetHashTable[clientId][data.hash])  {
            widgetHashTable[clientId][data.hash] = {}
        }

        var cache = widgetHashTable[clientId][data.hash],
            widgetData = data.data

        for (var k in widgetData) {
            if ((k === 'target' || k === 'preArgs')) {
                if (widgetData[k] !== '') {
                    cache[k] = Array.isArray(widgetData[k]) ? widgetData[k] : [widgetData[k]]
                } else {
                    cache[k] = []
                }
            } else {
                cache[k] = widgetData[k]
            }
        }

        // store raw target for client sync widget matching
        cache._rawTarget = widgetData.target

    },

    removeWidget(data, clientId) {
        // clear widget osc data

        delete widgetHashTable[clientId][data.hash]

    },

    reload(data) {
        // (dev) hot reload
        ipc.send('reload')

    },

    reloadCss() {
        // (dev) hot css reload

        theme.load()
        ipc.send('reloadCss')
    },

    log(data) {
        console.log(data)
    },

    error(data) {
        console.error(data)
    },

    errorLog(data) {
        console.error(data)
    },

    errorPopup(data) {
        ipc.send('error', data)
    },

    listDir(data, clientId) {
        // remote file browser backend

        var p = process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME']

        if (data.path) {
            // Resolve '~' to user's home directory
            if (data.path[0].startsWith('~')) {
                p = data.path[0].replace( "~", p );
            }
            else {
                p = path.resolve(...data.path)
            }
            //console.log(`Resolved path: ${p}`);
        }

        var root = settings.read('remote-root')
        if (root && !p.includes(root)) p = root

        fs.readdir(p, (err, files)=>{
            if (err) {
                ipc.send('notify', {class: 'error', message: err.message}, clientId)
                throw err
            } else {
                var extRe = data.extension ? new RegExp('.*\\.' + data.extension + '$') : /.*/
                var list = files.filter(x=>x[0] !== '.').map((x)=>{
                    var folder = false
                    try {
                        folder = fs.statSync(path.resolve(p, x)).isDirectory()
                    } catch(e) {}
                    return {
                        name: x,
                        folder
                    }
                })
                list = list.filter(x=>x.folder || x.name.match(extRe))
                ipc.send('listDir', {
                    path: p,
                    files: list
                }, clientId)
            }
        })


    },


}
