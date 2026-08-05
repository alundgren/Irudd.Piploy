/* global module */

// docker-modem loads SSH support unconditionally, but Piploy only uses the
// Docker daemon's Unix socket and never selects that transport.
module.exports = {};
