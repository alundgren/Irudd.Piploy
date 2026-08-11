import { describe, expect, it } from "vitest";
import type { NetworkInterfaceInfo } from "node:os";

import { findTailscaleAddress } from "../../src/mcpTailscale.js";

function ipv4(address: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: `${address}/24`,
  };
}

function ipv6(address: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: "ffff:ffff:ffff:ffff::",
    family: "IPv6",
    mac: "00:00:00:00:00:00",
    internal: false,
    cidr: `${address}/64`,
    scopeid: 0,
  };
}

describe("findTailscaleAddress", () => {
  it("returns undefined when the host has no interfaces", () => {
    expect(findTailscaleAddress({})).toBeUndefined();
  });

  it("returns undefined when every interface is unavailable", () => {
    expect(findTailscaleAddress({ tailscale0: undefined })).toBeUndefined();
  });

  it("returns an IPv4 address in Tailscale's CGNAT range", () => {
    expect(findTailscaleAddress({ utun4: [ipv4("100.101.102.103")] })).toBe(
      "100.101.102.103",
    );
  });

  it("uses the complete /10 range rather than matching only a textual prefix", () => {
    expect(
      findTailscaleAddress({
        utun4: [ipv4("100.127.255.255")],
        en0: [ipv4("100.128.0.0")],
      }),
    ).toBe("100.127.255.255");
  });

  it("selects a Tailscale address instead of LAN and loopback addresses", () => {
    expect(
      findTailscaleAddress({
        lo0: [ipv4("127.0.0.1")],
        en0: [ipv4("192.168.1.10")],
        utun4: [ipv4("100.64.0.1")],
      }),
    ).toBe("100.64.0.1");
  });

  it("returns the first matching address when no interface name breaks the tie", () => {
    expect(
      findTailscaleAddress({
        utun4: [ipv4("100.64.0.1")],
        utun5: [ipv4("100.64.0.2")],
      }),
    ).toBe("100.64.0.1");
  });

  it("prefers a matching address on a tailscale-named interface", () => {
    expect(
      findTailscaleAddress({
        wwan0: [ipv4("100.64.0.1")],
        tailscale0: [ipv4("100.64.0.2")],
      }),
    ).toBe("100.64.0.2");
  });

  it("ignores IPv6-only interfaces in v1", () => {
    expect(
      findTailscaleAddress({ utun4: [ipv6("fd7a:115c:a1e0::1")] }),
    ).toBeUndefined();
  });
});
