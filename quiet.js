/** @namespace */
var Quiet = (function() {
    // sampleBufferSize is the number of audio samples we'll write per onaudioprocess call
    // must be a power of two. we choose the absolute largest permissible value
    // we implicitly assume that the browser will play back a written buffer without any gaps
    var sampleBufferSize = 16384;

    // initialization flags
    var emscriptenInitialized = false;
    var profilesFetched = false;

    // profiles is the string content of quiet-profiles.json
    var profiles;

    // our local instance of window.AudioContext
    var audioCtx;

    // consumer callbacks. these fire once quiet is ready to create transmitter/receiver
    var readyCallbacks = [];

    // these are used for receiver only
    var gUM;
    var audioInput;
    var audioInputReadyCallbacks = [];
    var payloadBufferDefaultSize = Math.pow(2, 16);

    // isReady tells us if we can start creating transmitters and receivers
    // we need the emscripten portion to be running and we need our
    // async fetch of the profiles to be completed
    function isReady() {
        return emscriptenInitialized && profilesFetched;
    }

    // start gets our AudioContext and notifies consumers that quiet can be used
    function start() {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        console.log(audioCtx.sampleRate);
        var len = readyCallbacks.length;
        for (var i = 0; i < len; i++) {
            readyCallbacks[i]();
        }
    };

    function checkInitState() {
        if (isReady()) {
            start();
        }
    };

    function onProfilesFetch(p) {
        profiles = p;
        profilesFetched = true;
        checkInitState();
    };

    // this is intended to be called only by emscripten
    function onEmscriptenInitialized() {
        emscriptenInitialized = true;
        checkInitState();
    };

    /**
     * Set the path prefix of quiet-profiles.json and do an async fetch of that path.
     * This file is used to configure Transmitter and Receiver parameters.
     * <br><br>
     * This function must be called before creating a Transmitter or Receiver.
     * @function setProfilesPrefix
     * @memberof Quiet
     * @param {string} prefix - The path prefix where Quiet will fetch quiet-profiles.json
     * @example
     * setProfilesPrefix("/js/");  // fetches /js/quiet-profiles.json
     */
    function setProfilesPrefix(prefix) {
        if (profilesFetched) {
            return;
        }
        if (!prefix.endsWith("/")) {
            prefix += "/";
        }
        var profilesPath = prefix + "quiet-profiles.json";

        var fetch = new Promise(function(resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.overrideMimeType("application/json");
            xhr.open("GET", profilesPath, true);
            xhr.onload = function() {
                if (this.status >= 200 && this.status < 300) {
                    resolve(this.responseText);
                } else {
                    reject(this.statusText);
                }
            };
            xhr.onerror = function() {
                reject(this.statusText);
            };
            xhr.send();
        });

        fetch.then(function(body) {
            onProfilesFetch(body);
        }, function(err) {
            console.log(err);
        });
    };

    /**
     * Set the path prefix of quiet-emscripten.js.mem.
     * This file is used to initialize the memory state of emscripten.
     * <br><br>
     * This function must be called before quiet-emscripten.js has started loading.
     * If it is not called first, then emscripten will default to a prefix of "".
     * @function setMemoryInitializerPrefix
     * @memberof Quiet
     * @param {string} prefix - The path prefix where emscripten will fetch quiet-emscripten.js.mem
     * @example
     * setMemoryInitializerPrefix("/");  // fetches /quiet-emscripten.js.mem
     */
    function setMemoryInitializerPrefix(prefix) {
        Module.memoryInitializerPrefixURL = prefix;
    }

    /**
     * Add a callback to be called when Quiet is ready for use, e.g. when Transmitters and Receivers can be created.
     * @function addReadyCallback
     * @memberof Quiet
     * @param {function} c - The user function which will be called
     * @example
     * addReadyCallback(function() { console.log("ready!"); });
     */
    function addReadyCallback(c) {
        if (isReady()) {
            c();
            return
        }
        readyCallbacks.push(c);
    }

    /**
     * Callback used by transmit to notify user that transmission has finished
     * @callback onTransmitFinish
     * @memberof Quiet
     */

    /**
     * Callback for user to provide data to a Quiet transmitter
     * <br><br>
     * This callback may be used multiple times, but the user must wait for the finished callback between subsequent calls.
     * @callback transmit
     * @memberof Quiet
     * @param {string} payload - string which will be encoded and sent to speaker
     * @param {onTransmitFinish} [done] - callback to notify user that transmission has completed
     * @example
     * transmit("Hello, World!", function() { console.log("transmission complete"); });
     */

    /**
     * Create a new Transmitter configured by the given profile name.
     * @function newTransmitter
     * @memberof Quiet
     * @param {string} profileName - name of profile to use, must be a key in quiet-profiles.json
     * @returns {transmit} transmit - transmit callback which user calls to start transmission
     * @example
     * var transmit = newTransmitter("robust");
     * transmit("Hello, World!", function() { console.log("transmission complete"); });
     */
    function newTransmitter(profilename) {
        // get an encoder_options object for our quiet-profiles.json and profile key
        var c_profiles = Module.intArrayFromString(profiles);
        var c_profilename = Module.intArrayFromString(profilename);
        var opt = Module.ccall('get_encoder_profile_str', 'pointer', ['array', 'array'], [c_profiles, c_profilename]);

        // libquiet internally works at 44.1kHz but the local sound card may be a different rate. we inform quiet about that here
        Module.ccall('encoder_opt_set_sample_rate', 'number', ['pointer', 'number'], [opt, audioCtx.sampleRate]);

        var encoder = Module.ccall('create_encoder', 'pointer', ['pointer'], [opt]);

        // some profiles have an option called close_frame which prevents data frames from overlapping multiple
        //     sample buffers. this is very convenient if our system is not fast enough to feed the sound card
        //     without any gaps between subsequent buffers due to e.g. gc pause. inform quiet about our
        //     sample buffer size here so that it can reduce the frame length if this profile has close_frame enabled.
        Module.ccall('encoder_clamp_frame_len', null, ['pointer', 'number'], [encoder, sampleBufferSize]);
        var samples = Module.ccall('malloc', 'pointer', ['number'], [4 * sampleBufferSize]);

        // return user transmit function
        return function(payloadStr, done) {
            var payload = allocate(Module.intArrayFromString(payloadStr), 'i8', ALLOC_NORMAL);
            Module.ccall('encoder_set_payload', 'number', ['pointer', 'pointer', 'number'], [encoder, payload, payloadStr.length]);

            // yes, this is pointer arithmetic, in javascript :)
            var sample_view = Module.HEAPF32.subarray((samples/4), (samples/4) + sampleBufferSize);

            var script_processor = (audioCtx.createScriptProcessor || audioCtx.createJavaScriptNode);
            var transmitter = script_processor.call(audioCtx, sampleBufferSize, 1, 2);

            var finished = false;
            transmitter.onaudioprocess = function(e) {
                if (finished) {
                    transmitter.disconnect();
                    return;
                }

                var output_l = e.outputBuffer.getChannelData(0);
                var written = Module.ccall('encode', 'number', ['pointer', 'pointer', 'number'], [encoder, samples, sampleBufferSize]);
                output_l.set(sample_view);

                // libquiet notifies us that the payload is finished by returning written < number of samples we asked for
                if (written < sampleBufferSize) {
                    // be extra cautious and 0-fill what's left
                    //   (we want the end of transmission to be silence, not potentially loud noise)
                    for (var i = written; i < sampleBufferSize; i++) {
                        output_l[i] = 0;
                    }
                    // user callback
                    if (done !== undefined) {
                            done();
                    }
                    finished = true;
                }
            };

            // put an input node on the graph. some browsers require this to run our script processor
            // this oscillator will not actually be used in any way
            var dummy_osc = audioCtx.createOscillator();
            dummy_osc.type = 'square';
            dummy_osc.frequency.value = 420;
            dummy_osc.connect(transmitter);

            transmitter.connect(audioCtx.destination);
        };
    };

    // receiver functions

    function audioInputReady() {
        var len = audioInputReadyCallbacks.length;
        for (var i = 0; i < len; i++) {
            audioInputReadyCallbacks[i]();
        }
    };

    function addAudioInputReadyCallback(c) {
        if (audioInput instanceof MediaStreamAudioSourceNode) {
            c();
            return
        }
        audioInputReadyCallbacks.push(c);
    }

    function createAudioInput() {
        audioInput = 0; // prevent others from trying to create
        gUM.call(navigator, {
                audio: {
                    optional: [
                      {googAutoGainControl: false},
                      {googAutoGainControl2: false},
                      {googEchoCancellation: false},
                      {googEchoCancellation2: false},
                      {googNoiseSuppression: false},
                      {googNoiseSuppression2: false},
                      {googHighpassFilter: false},
                      {googTypingNoiseDetection: false},
                      {googAudioMirroring: false}
                    ]
                }
            }, function(e) {
                audioInput = audioCtx.createMediaStreamSource(e);

                // stash a very permanent reference so this isn't collected
                window.quiet_receiver_anti_gc = audioInput;

                audioInputReady();
            }, function() {
                console.log("failed to create an audio source");
        });
    };

    /**
     * Callback used by receiver to notify user of data received via microphone/line-in.
     *
     * @callback onReceive
     * @memberof Quiet
     * @param {string} payload - chunk of data received
     */

    /**
     * Create a new receiver with the profile specified by profileName (should match profile of transmitter).
     * @function newReceiver
     * @memberof Quiet
     * @param {string} profileName - name of profile to use, must be a key in quiet-profiles.json
     * @param {onReceive} onRecieve - callback which receiver will call to send user received data
     * @example
     * newReceiver("robust", function(payload) { console.log("received chunk of data: " + payload); });
     */
    function newReceiver(profileName, onReceive) {
        var c_profiles = Module.intArrayFromString(profiles);
        var c_profilename = Module.intArrayFromString(profileName);
        var opt = Module.ccall('get_decoder_profile_str', 'pointer', ['array', 'array'], [c_profiles, c_profilename]);

        // quiet creates audioCtx when it starts but it does not create an audio input
        // getting microphone access requires a permission dialog so only ask for it if we need it
        if (gUM === undefined) {
            gUM = (navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia);
        }
        if (audioInput === undefined) {
            createAudioInput()
        }

        // TODO investigate if this still needs to be placed on window.
        // seems this was done to keep it from being collected
        window.recorder = audioCtx.createScriptProcessor(16384, 2, 1);

        // inform quiet about our local sound card's sample rate so that it can resample to its internal sample rate
        Module.ccall('decoder_opt_set_sample_rate', 'number', ['pointer', 'number'], [opt, audioCtx.sampleRate]);

        var decoder = Module.ccall('create_decoder', 'pointer', ['pointer'], [opt]);

        var samples = Module.ccall('malloc', 'pointer', ['number'], [4 * sampleBufferSize]);

        // start our local payload buffer size at the default size given by the module
        var payloadBufferSize = payloadBufferDefaultSize;
        var payload = Module.ccall('malloc', 'pointer', ['number'], [payloadBufferSize]);

        window.recorder.onaudioprocess = function(e) {
            var input = e.inputBuffer.getChannelData(0);
            var sample_view = Module.HEAPF32.subarray(samples/4, samples/4 + sampleBufferSize);
            sample_view.set(input);

            // quiet tells us how many bytes are stored in its internal payload buffer
            var payloadBuffered = Module.ccall('decode', 'number', ['pointer', 'pointer', 'number'], [decoder, samples, sampleBufferSize]);

            // resize our buffer if we need to receive more payload than can fit
            if (payloadBuffered > payloadBufferSize) {
                payload = Module.ccall('realloc', 'pointer', ['pointer', 'number'], [payload, payloadBuffered]);
                payloadBufferSize = payloadBuffered;
            }

            // if anything was received, copy it out and pass it to user
            if (payloadBuffered > 0) {
                // retrieve every byte
                Module.ccall('decoder_readbuf', 'number', ['pointer', 'pointer', 'number'], [decoder, payload, payloadBuffered]);

                // convert from emscripten bytes to js string. more pointer arithmetic.
                var payloadArray = Module.HEAP8.subarray(payload, payload + payloadBuffered)
                var payloadStr = String.fromCharCode.apply(null, new Uint8Array(payloadArray));

                // call user callback with the payload
                onReceive(payloadStr);
            }
        }

        // if this is the first receiver object created, wait for our input node to be created
        addAudioInputReadyCallback(function() {
            audioInput.connect(window.recorder);
        });

        // more unused nodes in the graph that some browsers insist on having
        var fakeGain = audioCtx.createGain();
        fakeGain.value = 0;
        window.recorder.connect(fakeGain);
        fakeGain.connect(audioCtx.destination);
    };

    return {
        emscriptenInitialized: onEmscriptenInitialized,
        setProfilesPrefix: setProfilesPrefix,
        setMemoryInitializerPrefix: setMemoryInitializerPrefix,
        addReadyCallback: addReadyCallback,
        transmitter: newTransmitter,
        receiver: newReceiver
    };
})();

// extend emscripten Module
var Module = {
    onRuntimeInitialized: Quiet.emscriptenInitialized,
    memoryInitializerPrefixURL: ""
};