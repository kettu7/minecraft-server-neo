/** Dateiname für den Download – ASCII-Ersatz plus UTF-8-Variante für Umlaute (RFC 6266) */
export function contentDisposition(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'blaupause.litematic';
  const withExt = /\.litematic$/i.test(safe) ? safe : `${safe}.litematic`;
  const ascii = withExt.normalize('NFKD').replace(/[^\x20-\x7e]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(withExt)}`;
}
