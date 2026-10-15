// Liest SNBT (die Textform von NBT), wie sie /data get ausgibt, z. B.
// {Items: [{Slot: 0b, count: 64, id: "minecraft:stone"}], id: "minecraft:chest"}

export type SnbtValue = string | number | boolean | SnbtValue[] | { [key: string]: SnbtValue };

// Unquotierte Werte dürfen ":" enthalten (minecraft:stone), unquotierte Schlüssel nicht
const BARE_VALUE = /[A-Za-z0-9_\-.+:]/;
const BARE_KEY = /[A-Za-z0-9_\-.+]/;

export function parseSnbt(text: string): SnbtValue {
  let i = 0;

  const fail = (msg: string): never => {
    throw new Error(`SNBT: ${msg} an Position ${i}: …${text.slice(Math.max(0, i - 20), i + 20)}…`);
  };
  const skip = () => { while (i < text.length && /\s/.test(text[i])) i++; };
  const expect = (c: string) => { skip(); if (text[i] !== c) fail(`'${c}' erwartet`); i++; };

  function quoted(): string {
    const q = text[i++];
    let out = '';
    while (i < text.length && text[i] !== q) {
      if (text[i] === '\\') { out += text[i + 1]; i += 2; } else out += text[i++];
    }
    if (text[i] !== q) fail('String nicht beendet');
    i++;
    return out;
  }

  function bare(allowed = BARE_VALUE): string {
    const start = i;
    while (i < text.length && allowed.test(text[i])) i++;
    if (start === i) fail('Wert erwartet');
    return text.slice(start, i);
  }

  function scalar(token: string): SnbtValue {
    if (token === 'true') return true;
    if (token === 'false') return false;
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([bslfd]?)$/i.exec(token);
    return m ? Number(m[1]) : token;
  }

  function value(): SnbtValue {
    skip();
    const c = text[i];
    if (c === '{') {
      i++;
      const obj: { [key: string]: SnbtValue } = {};
      skip();
      if (text[i] === '}') { i++; return obj; }
      for (;;) {
        skip();
        const key = text[i] === '"' || text[i] === "'" ? quoted() : bare(BARE_KEY);
        expect(':');
        obj[key] = value();
        skip();
        if (text[i] === ',') { i++; continue; }
        expect('}');
        return obj;
      }
    }
    if (c === '[') {
      i++;
      skip();
      // Typisierte Arrays: [I; 1, 2], [B; ...], [L; ...]
      if (/[BIL]/.test(text[i]) && text[i + 1] === ';') i += 2;
      const list: SnbtValue[] = [];
      skip();
      if (text[i] === ']') { i++; return list; }
      for (;;) {
        list.push(value());
        skip();
        if (text[i] === ',') { i++; continue; }
        expect(']');
        return list;
      }
    }
    if (c === '"' || c === "'") return quoted();
    return scalar(bare());
  }

  const result = value();
  skip();
  if (i < text.length) fail('Unerwarteter Text');
  return result;
}
