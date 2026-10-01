/// <reference types="@cloudflare/workers-types" />

/** Wrangler 支持把 .html 当文本模块导入 */
declare module '*.html' {
  const content: string;
  export default content;
}
