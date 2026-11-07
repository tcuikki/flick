/**
 * AI が書いたタスク名に、話した（書いた）元の文には無い漢字が混ざっていたら返す。
 * 以前、AI がタイトルを書き直すときに「仕上げる」→「棗了る」のような字化けが起きたため、
 * 追加する前にこの目印を見せて、人が確かめられるようにする。
 */
export function strangeKanji(title: string, source: string): string[] {
  const src = new Set(source);
  return [...new Set([...title].filter((ch) => /[㐀-鿿]/.test(ch) && !src.has(ch)))];
}
