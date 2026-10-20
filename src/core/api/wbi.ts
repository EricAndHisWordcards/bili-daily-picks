import { md5 } from './md5';

/**
 * B站 WBI 签名。
 *
 * 参考公开实现：取 nav 接口返回的 img_url / sub_url 文件名，拼接后按固定 64 位置换表
 * 取前 32 位得到 mixin key；请求参数加 wts 后按 key 排序、URL 编码，拼上 mixin key
 * 做 MD5 得到 w_rid。
 */

export const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54,
  21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
] as const;

/** 从 wbi_img 的 URL 里取出 key（去扩展名的文件名） */
export function keyFromUrl(url: string): string {
  const file = url.split('/').pop() ?? '';
  return file.split('.')[0] ?? '';
}

export function mixinKeyFrom(imgKey: string, subKey: string): string {
  const raw = imgKey + subKey;
  let out = '';
  for (const idx of MIXIN_KEY_ENC_TAB) {
    out += raw[idx] ?? '';
  }
  return out.slice(0, 32);
}

/** WBI 要求的 URL 编码：encodeURIComponent 之后再转义 !'()* */
export function encodeParam(value: string | number): string {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/**
 * 生成带 w_rid / wts 的查询串（不含前导 `?`）。
 */
export function signQuery(
  params: Record<string, string | number>,
  mixinKey: string,
  wts: number = Math.floor(Date.now() / 1000),
): string {
  const all: Record<string, string | number> = { ...params, wts };
  const query = Object.keys(all)
    .sort()
    .map((k) => `${encodeParam(k)}=${encodeParam(all[k] as string | number)}`)
    .join('&');
  return `${query}&w_rid=${md5(query + mixinKey)}`;
}

export interface WbiKeys {
  imgKey: string;
  subKey: string;
  mixinKey: string;
}

export function buildWbiKeys(imgUrl: string, subUrl: string): WbiKeys {
  const imgKey = keyFromUrl(imgUrl);
  const subKey = keyFromUrl(subUrl);
  return { imgKey, subKey, mixinKey: mixinKeyFrom(imgKey, subKey) };
}
