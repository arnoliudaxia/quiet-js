var TextReceiver = (function() {
    Quiet.init({
        profilesPrefix: "/quiet-js/test/",
        memoryInitializerPrefix: "/quiet-js/javascripts/",
        libfecPrefix: "/quiet-js/javascripts/"
    });
    var target;
    var content = new ArrayBuffer(0);
    var warningbox;
    var stats = {
        firstFrameReceived: null,
        lastFrameReceived: null,
        framesReceived: 0,
        framesFailed: 0,
        bytesRecevied: 0,
        rssi: null,
        evm: null
    };
    var statsBoxes = {
        firstFrameReceived: document.createElement('div'),
        lastFrameReceived: document.createElement('div'),
        framesReceived: document.createElement('div'),
        framesFailed: document.createElement('div'),
        bytesReceived: document.createElement('div'),
        bitrate: document.createElement('div'),
        rssi: document.createElement('div'),
        evm: document.createElement('div')
    };

    function updateStats() {
        var recvDuration = stats.lastFrameReceived - stats.firstFrameReceived;
        var bitrate = (stats.bytesReceived * 8) / (recvDuration / 1000);

        if (stats.firstFrameReceived == null) {
            statsBoxes.firstFrameReceived = "First Frame Received: ---";
        } else {
            statsBoxes.firstFrameReceived = "First Frame Received: " + stats.firstFrameReceived.toDateString();
        }

        if (stats.rssi == null) {
            statsBoxes.rssi = "RSSI: ---";
        } else {
            statsBoxes.rssi = "RSSI: " + stats.rssi + " dB";
        }

        if (stats.evm == null) {
            statsBoxes.evm = "EVM: ---";
        } else {
            statsBoxes.evm = "EVM: " + stats.evm + " dB";
        }
    };

    function onReceive(recvPayload) {
        stats.bytesReceived += recvPayload.byteLength;
        stats.framesReceived++;
        stats.lastFrameReceived = new Date();
        if (stats.firstFrameReceived == null) {
            stats.firstFrameReceived = new Date();
        }
        updateStats();
    };

    function onReceiveFail(num_fails) {
        stats.framesFailed++;
        stats.lastFrameReceived = new Date();
        if (stats.firstFrameReceived == null) {
            stats.firstFrameReceived = new Date();
        }
        updateStats();
    };

    function onReceiverCreateFail(reason) {
        console.log("failed to create quiet receiver: " + reason);
        warningbox.classList.remove("hidden");
        warningbox.textContent = "Sorry, it looks like this example is not supported by your browser. Please give permission to use the microphone or try again in Google Chrome or Microsoft Edge."
    };

    function onReceiverStatsUpdate(update) {
        if (receiver === undefined) {
            return;
        }
        if (update.length > 0) {
            stats.rssi = update[0].receivedSignalStrengthIndicator.toFixed(2);
            var evm = update[0].errorVectorMagnitude;
            if (evm != 0) {
                stats.evm = evm.toFixed(2);
            }
        }
        updateStats();
    };

    function onQuietReady() {
        var profilename = document.querySelector('[data-quiet-profile-name]').getAttribute('data-quiet-profile-name');
        Quiet.receiver({profile: profilename,
             onReceive: onReceive,
             onCreateFail: onReceiverCreateFail,
             onReceiveFail: onReceiveFail,
             onReceiverStatsUpdate: onReceiverStatsUpdate
        });
    };

    function onQuietFail(reason) {
        console.log("quiet failed to initialize: " + reason);
        warningbox.classList.remove("hidden");
        warningbox.textContent = "Sorry, it looks like there was a problem with this example (" + reason + ")";
    };

    function onDOMLoad() {
        target = document.querySelector('[data-quiet-receive-test-target]');
        target.appendChild(statsBoxes.firstFrameReceived);
        target.appendChild(statsBoxes.lastFrameReceived);
        target.appendChild(statsBoxes.framesReceived);
        target.appendChild(statsBoxes.framesFailed);
        target.appendChild(statsBoxes.bytesReceived);
        target.appendChild(statsBoxes.bitrate);
        target.appendChild(statsBoxes.rssi);
        target.appendChild(statsBoxes.evm);
        warningbox = document.querySelector('[data-quiet-warning]');
        Quiet.addReadyCallback(onQuietReady, onQuietFail);
    };

    document.addEventListener("DOMContentLoaded", onDOMLoad);
})();
