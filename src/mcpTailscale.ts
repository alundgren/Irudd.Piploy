import * as os from "node:os";

const tailscaleCgnatNetwork = 0x64400000;
const tailscaleCgnatMask = 0xffc00000;

function ipv4ToNumber(address: string): number | undefined {
  const octets = address.split(".");
  if (octets.length !== 4) return undefined;

  let value = 0;
  for (const octet of octets) {
    const number = Number(octet);
    if (!Number.isInteger(number) || number < 0 || number > 255) {
      return undefined;
    }
    value = (value << 8) | number;
  }
  return value >>> 0;
}

function isTailscaleIpv4(address: string): boolean {
  const value = ipv4ToNumber(address);
  return (
    value !== undefined &&
    (value & tailscaleCgnatMask) === tailscaleCgnatNetwork
  );
}

export function findTailscaleAddress(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): string | undefined {
  let firstMatch: string | undefined;
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && isTailscaleIpv4(address.address)) {
        if (name.startsWith("tailscale")) return address.address;
        firstMatch ??= address.address;
      }
    }
  }
  // Interface enumeration determines this fallback, so it is deliberately
  // arbitrary when no matching interface has a Tailscale-specific name.
  return firstMatch;
}

/**
 * IPv6 Tailscale addresses (`fd7a:115c:a1e0::/48`) are out of scope for v1.
 */
export function getTailscaleAddress(): string | undefined {
  return findTailscaleAddress(os.networkInterfaces());
}
