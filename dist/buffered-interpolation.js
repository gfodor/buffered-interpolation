"use strict";

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

/* global THREE */

var INITIALIZING = 0;
var BUFFERING = 1;
var PLAYING = 2;
var PAUSED = 3;

var MODE_LERP = 0;
var MODE_HERMITE = 1;

var vectorPool = [];
var quatPool = [];
var framePool = [];

var getPooledVector = function getPooledVector() {
  return vectorPool.shift() || new THREE.Vector3();
};
var getPooledQuaternion = function getPooledQuaternion() {
  return quatPool.shift() || new THREE.Quaternion();
};

var getPooledFrame = function getPooledFrame() {
  var frame = framePool.pop();

  if (!frame) {
    frame = { position: new THREE.Vector3(), velocity: new THREE.Vector3(), scale: new THREE.Vector3(), quaternion: new THREE.Quaternion(), time: 0 };
  }

  return frame;
};

var freeFrame = function freeFrame(f) {
  return framePool.push(f);
};

var almostEqualVec3 = function almostEqualVec3(u, v, epsilon) {
  return Math.abs(u.x - v.x) < epsilon && Math.abs(u.y - v.y) < epsilon && Math.abs(u.z - v.z) < epsilon;
};

var almostEqualQuat = function almostEqualQuat(u, v, epsilon) {
  return Math.abs(u.x - v.x) < epsilon && Math.abs(u.y - v.y) < epsilon && Math.abs(u.z - v.z) < epsilon && Math.abs(u.w - v.w) < epsilon;
};

var InterpolationBuffer = function () {
  function InterpolationBuffer() {
    var mode = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : MODE_LERP;
    var bufferTime = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : 0.15;

    _classCallCheck(this, InterpolationBuffer);

    this.state = INITIALIZING;
    this.buffer = [];
    this.bufferTime = bufferTime * 1000;
    this.time = 0;
    this.lastTailCopyFrame = null;
    this.mode = mode;

    this.originFrame = getPooledFrame();
    this.position = new THREE.Vector3();
    this.quaternion = new THREE.Quaternion();
    this.scale = new THREE.Vector3(1, 1, 1);
  }

  _createClass(InterpolationBuffer, [{
    key: "hermite",
    value: function hermite(target, t, p1, p2, v1, v2) {
      var t2 = t * t;
      var t3 = t * t * t;
      var a = 2 * t3 - 3 * t2 + 1;
      var b = -2 * t3 + 3 * t2;
      var c = t3 - 2 * t2 + t;
      var d = t3 - t2;

      target.copy(p1.multiplyScalar(a));
      target.add(p2.multiplyScalar(b));
      target.add(v1.multiplyScalar(c));
      target.add(v2.multiplyScalar(d));
    }
  }, {
    key: "lerp",
    value: function lerp(target, v1, v2, alpha) {
      target.lerpVectors(v1, v2, alpha);
    }
  }, {
    key: "slerp",
    value: function slerp(target, r1, r2, alpha) {
      THREE.Quaternion.slerp(r1, r2, target, alpha);
    }
  }, {
    key: "updateOriginFrameToBufferTail",
    value: function updateOriginFrameToBufferTail() {
      freeFrame(this.originFrame);
      this.originFrame = this.buffer.shift();
    }
  }, {
    key: "appendBuffer",
    value: function appendBuffer(position, velocity, quaternion, scale) {
      var tail = this.buffer.length > 0 ? this.buffer[this.buffer.length - 1] : null;
      // update the last entry in the buffer if this is the same frame
      if (tail && tail.time === this.time) {
        if (position) {
          tail.position.copy(position);
        }

        if (velocity) {
          tail.velocity.copy(velocity);
        }

        if (quaternion) {
          tail.quaternion.copy(quaternion);
        }

        if (scale) {
          tail.scale.copy(scale);
        }
      } else {
        var priorFrame = tail || this.originFrame;
        var newFrame = getPooledFrame();
        newFrame.position.copy(position || priorFrame.position);
        newFrame.velocity.copy(velocity || priorFrame.velocity);
        newFrame.quaternion.copy(quaternion || priorFrame.quaternion);
        newFrame.scale.copy(scale || priorFrame.scale);
        newFrame.time = this.time;

        this.buffer.push(newFrame);
      }

      if (this.state === PAUSED) {
        this.state = PLAYING;
      }
    }
  }, {
    key: "setTarget",
    value: function setTarget(position, velocity, quaternion, scale) {
      this.appendBuffer(position, velocity, quaternion, scale);
    }
  }, {
    key: "setPosition",
    value: function setPosition(position, velocity) {
      this.appendBuffer(position, velocity, null, null);
    }
  }, {
    key: "setQuaternion",
    value: function setQuaternion(quaternion) {
      this.appendBuffer(null, null, quaternion, null);
    }
  }, {
    key: "setScale",
    value: function setScale(scale) {
      this.appendBuffer(null, null, null, scale);
    }

    // Returns t/f if the update results in a dirty pos/rot/scale.

  }, {
    key: "update",
    value: function update(delta) {
      if (this.state === INITIALIZING) {
        if (this.buffer.length > 0) {
          this.updateOriginFrameToBufferTail();
          this.position.copy(this.originFrame.position);
          this.quaternion.copy(this.originFrame.quaternion);
          this.scale.copy(this.originFrame.scale);
          this.state = BUFFERING;
        }
      }

      if (this.state === BUFFERING) {
        if (this.buffer.length > 0 && this.time > this.bufferTime) {
          this.state = PLAYING;
        }
      }

      if (this.state === PAUSED) {
        var tailFrame = this.buffer[0];
        tailFrame.time = this.time + delta;

        return false;
      }

      if (this.state === PLAYING) {
        var tailFrameUsedThisFrame = false;

        var mark = this.time - this.bufferTime;
        //Purge this.buffer of expired frames
        while (this.buffer.length > 0 && mark > this.buffer[0].time) {
          //if this is the last frame in the buffer, just update the time and reuse it
          if (this.buffer.length > 1) {
            this.updateOriginFrameToBufferTail();
          } else {
            var _tailFrame = this.buffer[0];

            this.originFrame.position.copy(_tailFrame.position);
            this.originFrame.velocity.copy(_tailFrame.velocity);
            this.originFrame.quaternion.copy(_tailFrame.quaternion);
            this.originFrame.scale.copy(_tailFrame.scale);
            this.originFrame.time = _tailFrame.time;
            _tailFrame.time = this.time + delta;
            tailFrameUsedThisFrame = true;
          }
        }
        if (this.buffer.length > 0 && this.buffer[0].time > 0) {
          var targetFrame = this.buffer[0];
          var delta_time = targetFrame.time - this.originFrame.time;
          var alpha = (mark - this.originFrame.time) / delta_time;

          if (this.mode === MODE_LERP) {
            this.lerp(this.position, this.originFrame.position, targetFrame.position, alpha);
          } else if (this.mode === MODE_HERMITE) {
            this.hermite(this.position, alpha, this.originFrame.position, targetFrame.position, this.originFrame.velocity.multiplyScalar(delta_time), targetFrame.velocity.multiplyScalar(delta_time));
          }

          this.slerp(this.quaternion, this.originFrame.quaternion, targetFrame.quaternion, alpha);

          this.lerp(this.scale, this.originFrame.scale, targetFrame.scale, alpha);

          if (tailFrameUsedThisFrame) {
            var reachedPos = almostEqualVec3(this.position, targetFrame.position, 0.0001);
            var reachedRot = almostEqualQuat(this.quaternion, targetFrame.quaternion, 0.001);
            var reachedScale = almostEqualVec3(this.scale, targetFrame.scale, 0.0001);

            if (reachedPos && reachedRot && reachedScale) {
              // Once the target is converged onto, pause lerping until we see new data.
              this.state = PAUSED;
            }
          }
        }
      }

      if (this.state !== INITIALIZING) {
        this.time += delta;
      }

      return true;
    }
  }, {
    key: "getPosition",
    value: function getPosition() {
      return this.position;
    }
  }, {
    key: "getQuaternion",
    value: function getQuaternion() {
      return this.quaternion;
    }
  }, {
    key: "getScale",
    value: function getScale() {
      return this.scale;
    }
  }]);

  return InterpolationBuffer;
}();

module.exports = InterpolationBuffer;
