// Offline-Demo: Steckt in der Seite eine Momentaufnahme (window.__NEO_DEMO__), beantwortet die Website alle
// API-Anfragen daraus statt vom Server. Bilder und Downloads kommen ebenfalls aus der Momentaufnahme.
// Änderungen (POST/PUT/PATCH/DELETE) sind in der Demo nicht möglich. Ohne Momentaufnahme passiert hier nichts.
import { HttpErrorResponse, HttpResponse, type HttpInterceptorFn } from '@angular/common/http';
import { of, throwError } from 'rxjs';

export interface DemoSnapshot {
  createdAt: string;
  /** "GET /api/projects" bzw. "GET /api/mods/search?q=graves" → Antwort */
  responses: Record<string, unknown>;
  /** URL → data:-URI (Item-Bilder, Mod-Icons, Projektbilder, Avatare, Kartenbild unter "demo:map") */
  assets: Record<string, string>;
  /** URL → Datei zum Herunterladen */
  downloads: Record<string, { name: string; type: string; base64: string }>;
}

declare global {
  interface Window { __NEO_DEMO__?: DemoSnapshot }
}

export const demo: DemoSnapshot | undefined = typeof window !== 'undefined' ? window.__NEO_DEMO__ : undefined;
export const isDemo = !!demo;

const NOT_IN_DEMO = 'Offline-Demo: Änderungen sind hier nicht möglich – das ist eine Vorschau mit festem Stand.';

/** Pfad ohne Origin, Parameter sortiert – so wie die Momentaufnahme die Schlüssel speichert */
export function demoKey(method: string, url: string) {
  const u = new URL(url, 'http://neo.local');
  const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  return `${method.toUpperCase()} ${u.pathname}${query}`;
}

export const demoInterceptor: HttpInterceptorFn = (req, next) => {
  if (!demo) return next(req);
  const url = req.urlWithParams;
  if (req.method !== 'GET') {
    return throwError(() => new HttpErrorResponse({ status: 403, url, error: { error: NOT_IN_DEMO } }));
  }
  const exact = demoKey('GET', url);
  const pathOnly = exact.split('?')[0];
  // Unbekannte Suchanfragen o. Ä.: auf die Variante ohne Parameter zurückfallen
  const fallback = Object.keys(demo.responses).find((k) => k.split('?')[0] === pathOnly);
  const key = exact in demo.responses ? exact : pathOnly in demo.responses ? pathOnly : fallback;
  if (!key) {
    return throwError(() => new HttpErrorResponse({ status: 404, url, error: { error: 'Offline-Demo: Diese Ansicht ist nicht gespeichert.' } }));
  }
  return of(new HttpResponse({ status: 200, url, body: structuredClone(demo.responses[key]) }));
};

/** Bild-Adressen auf eingebettete Bilder umbiegen und Download-Links aus der Momentaufnahme bedienen */
export function installDemo() {
  if (!demo) return;
  const assets = demo.assets;
  const resolve = (value: string) => {
    if (typeof value !== 'string' || value.startsWith('data:') || value.startsWith('blob:')) return value;
    if (assets[value]) return assets[value];
    try {
      const u = new URL(value, 'http://neo.local');
      const local = u.host === 'neo.local' || u.protocol === 'file:' ? u.pathname + u.search : value;
      return assets[local] ?? assets[local.split('?')[0]] ?? value;
    } catch {
      return value;
    }
  };

  const src = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')!;
  Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true,
    get() { return src.get!.call(this); },
    set(value: string) { src.set!.call(this, resolve(value)); },
  });
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name: string, value: string) {
    return setAttribute.call(this, name, this instanceof HTMLImageElement && name === 'src' ? resolve(value) : value);
  };

  // Links auf /api/… (Modpack, Blaupausen) aus der Momentaufnahme herunterladen
  document.addEventListener('click', (event) => {
    const a = event.target instanceof Element ? event.target.closest('a') : null;
    const href = a?.getAttribute('href');
    if (!href?.startsWith('/api/')) return;
    event.preventDefault();
    const file = demo.downloads[href];
    if (!file) {
      alert('Offline-Demo: Dieser Download ist in der Vorschau nicht enthalten.');
      return;
    }
    const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: file.type }));
    const link = Object.assign(document.createElement('a'), { href: url, download: file.name });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, true);
}
