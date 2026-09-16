// Closes its stdin before the client can write: the parent's write hits EPIPE.
process.stdin.destroy();
setInterval(() => {}, 1_000);
