'use strict';

// index.js と scheduler.js で共有する処理中フラグ
let locked = false;

module.exports = {
  isLocked: () => locked,
  lock:     () => { locked = true; },
  unlock:   () => { locked = false; },
};
