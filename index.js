/* global THREE */

const INITIALIZING = 0;
const BUFFERING = 1;
const PLAYING = 2;
const PAUSED = 3;

const MODE_LERP = 0;
const MODE_HERMITE = 1;

const vectorPool = [];
const quatPool = [];
const framePool = [];

const getPooledVector = () => vectorPool.shift() || new THREE.Vector3();
const getPooledQuaternion = () => quatPool.shift() || new THREE.Quaternion();

const getPooledFrame = () => {
  let frame = framePool.pop();

  if (!frame) {
    frame = { position: new THREE.Vector3(), velocity: new THREE.Vector3(), scale: new THREE.Vector3(), quaternion: new THREE.Quaternion(), time: 0 };
  }

  return frame;
};

const freeFrame = f => framePool.push(f);

const almostEqualVec3 = function(u, v, epsilon) {
  return Math.abs(u.x-v.x)<epsilon && Math.abs(u.y-v.y)<epsilon && Math.abs(u.z-v.z)<epsilon;
};

const almostEqualQuat = function(u, v, epsilon) {
  return Math.abs(u.x-v.x)<epsilon && Math.abs(u.y-v.y)<epsilon && Math.abs(u.z-v.z)<epsilon && Math.abs(u.w-v.w)<epsilon;
};

class InterpolationBuffer {
  constructor(mode = MODE_LERP, bufferTime = 0.15) {
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

  hermite(target, t, p1, p2, v1, v2) {
    const t2 = t * t;
    const t3 = t * t * t;
    const a = 2 * t3 - 3 * t2 + 1;
    const b = -2 * t3 + 3 * t2;
    const c = t3 - 2 * t2 + t;
    const d = t3 - t2;

    target.copy(p1.multiplyScalar(a));
    target.add(p2.multiplyScalar(b));
    target.add(v1.multiplyScalar(c));
    target.add(v2.multiplyScalar(d));
  }

  lerp(target, v1, v2, alpha) {
    target.lerpVectors(v1, v2, alpha);
  }

  slerp(target, r1, r2, alpha) {
    THREE.Quaternion.slerp(r1, r2, target, alpha);
  }

  updateOriginFrameToBufferTail() {
    freeFrame(this.originFrame);
    this.originFrame = this.buffer.shift();
  }

  appendBuffer(position, velocity, quaternion, scale) {
    const tail = this.buffer.length > 0 ? this.buffer[this.buffer.length - 1] : null;
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
      const priorFrame = tail || this.originFrame;
      const newFrame = getPooledFrame();
      newFrame.position.copy(position || priorFrame.position);
      newFrame.velocity.copy(velocity ||  priorFrame.velocity);
      newFrame.quaternion.copy(quaternion || priorFrame.quaternion);
      newFrame.scale.copy(scale || priorFrame.scale);
      newFrame.time = this.time;

      this.buffer.push(newFrame);
    }

    if (this.state === PAUSED) {
      this.state = PLAYING;
    }
  }

  setTarget(position, velocity, quaternion, scale) {
    this.appendBuffer(position, velocity, quaternion, scale);
  }

  setPosition(position, velocity) {
    this.appendBuffer(position, velocity, null, null);
  }

  setQuaternion(quaternion) {
    this.appendBuffer(null, null, quaternion, null);
  }

  setScale(scale) {
    this.appendBuffer(null, null, null, scale);
  }

  // Returns t/f if the update results in a dirty pos/rot/scale.
  update(delta, maxLerpDistance) {
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
      const tailFrame = this.buffer[0];
      tailFrame.time = this.time + delta;

      return false;
    }

    if (this.state === PLAYING) {
      let tailFrameUsedThisFrame = false;

      const mark = this.time - this.bufferTime;
      //Purge this.buffer of expired frames
      while (this.buffer.length > 0 && mark > this.buffer[0].time) {
        //if this is the last frame in the buffer, just update the time and reuse it
        if (this.buffer.length > 1) {
          this.updateOriginFrameToBufferTail();
        } else {
          const tailFrame = this.buffer[0];

          this.originFrame.position.copy(tailFrame.position);
          this.originFrame.velocity.copy(tailFrame.velocity);
          this.originFrame.quaternion.copy(tailFrame.quaternion);
          this.originFrame.scale.copy(tailFrame.scale);
          this.originFrame.time = tailFrame.time;
          tailFrame.time = this.time + delta;
          tailFrameUsedThisFrame = true;
        }
      }
      if (this.buffer.length > 0 && this.buffer[0].time > 0) {
        const targetFrame = this.buffer[0];
        const delta_time = targetFrame.time - this.originFrame.time;
        const alpha = (mark - this.originFrame.time) / delta_time;

        if (maxLerpDistance && 
          (Math.abs(targetFrame.position.x - this.originFrame.position.x) > maxLerpDistance || 
           Math.abs(targetFrame.position.y - this.originFrame.position.y) > maxLerpDistance || 
           Math.abs(targetFrame.position.z - this.originFrame.position.z) > maxLerpDistance)) {
          this.position.set(targetFrame.position.x, targetFrame.position.y, targetFrame.position.z);
        } else if (this.mode === MODE_LERP) {
          this.lerp(this.position, this.originFrame.position, targetFrame.position, alpha);
        } else if (this.mode === MODE_HERMITE) {
          this.hermite(
            this.position,
            alpha,
            this.originFrame.position,
            targetFrame.position,
            this.originFrame.velocity.multiplyScalar(delta_time),
            targetFrame.velocity.multiplyScalar(delta_time)
          );
        }

        this.slerp(this.quaternion, this.originFrame.quaternion, targetFrame.quaternion, alpha);

        this.lerp(this.scale, this.originFrame.scale, targetFrame.scale, alpha);

        if (tailFrameUsedThisFrame) {
          const reachedPos = almostEqualVec3(this.position, targetFrame.position, 0.0001);
          const reachedRot = almostEqualQuat(this.quaternion, targetFrame.quaternion, 0.001);
          const reachedScale = almostEqualVec3(this.scale, targetFrame.scale, 0.0001);

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

  getPosition() {
    return this.position;
  }

  getQuaternion() {
    return this.quaternion;
  }

  getScale() {
    return this.scale;
  }
}

module.exports = InterpolationBuffer;
