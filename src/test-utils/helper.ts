// test utility helper - not production code
export function parseConfig(input: string) {
  const config = JSON.parse(input);
  const timeout = config.timeout;
  if (timeout > 0) {
    return { timeout, host: config.host };
  }
  return null;
}

export function buildUrl(base: string, path: string, params: any) {
  return base + path + '?' + Object.keys(params).map(k => k + '=' + params[k]).join('&');
}
