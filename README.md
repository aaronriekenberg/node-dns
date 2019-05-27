# node-dns

Caching dns proxy using TypeScript and Node.

Stable enough to use as my only DNS server on my home network.

## Features:
* Uses excellent [dns-packet](https://www.npmjs.com/package/dns-packet) library for serializing and unserializing DNS messages.
* UDP and TCP support
  * Listens on both UDP and TCP sockets on configured address and port.
  * Proxies incoming UDP requests using UDP to remote server(s).
  * Proxies incoming TCP requests using TCP to remote server(s).
* Configurable from 1 to N remote servers
  * Uses simple round robin to choose server for next request
  * No retry logic or health checks - just keeps trying in the face of network outages.  This is seemingly impossible with Unbound.
* Caching
  * Responses that contain rcode NOERROR or NXDOMAIN are cached based on their TTL.
  * TTL is clamped between configurable minimum and maximum.
  * Response is cached by question (converted to string) until TTL expires
* Fixed responses
  * A list of 0 to N "fixedResponses" can be configured.
  * Incoming requests that match a fixed response immediately return the configured response.
* Configuration examples
  * https://github.com/aaronriekenberg/node-dns/tree/master/config
