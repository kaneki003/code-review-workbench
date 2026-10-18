const native = require(process.argv[2]);
const lockPath = process.argv[3];
let guard;

function acquire() {
  guard = native.tryAcquire(lockPath);
  process.send({ status: guard ? 'held' : 'busy' });
}

process.on('message', (action) => {
  if (action === 'acquire') acquire();
  if (action === 'release') {
    process.send({ status: native.release(guard) ? 'released' : 'already-released' });
  }
});
acquire();
