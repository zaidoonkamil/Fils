const ARABIC_BAD_WORDS = [
  "خايسة",
  "خايس",
  "خايص",
  "خايصة",
  "كواد",
  "خصوة",
  "خصوتي",

  "كوادَه",
  "كوادَه",
  "كوادين",
  "كوادات",
  "ديوث",
  "ديوثة",
  "ديوثه",
  "منيوك",
  "منيوكة",
  "منيوكه",
  "مطي",
  "مطية",
  "مطية",
  "مطيه",
  "لوطي",
  "لوطية",
  "لوطيه",
  "بندوق",
  "بندوك",
  "تفو",
  "تفوو",
  "تفل",
  "تفلون",
  "زق",
  "يزق",
  "زقي",
  "زقوا",
  "زقيت",
  "زبالة",
  "زباله",
  "نجس",
  "نِجِس",
  "وصخ",
  "وصخة",
  "وصخه",
  "قذر",
  "قذرة",
  "قذره",
  "وسخ",
  "وسخة",
  "وسخه",
  "قحبة",
  "قحبه",
  "شرموطة",
  "شرموطه",
  "عاهر",
  "عاهرة",
  "عاهره",
  "زاني",
  "زانية",
  "زانيه",
  "ساقط",
  "ساقطة",
  "ساقطه",
  "فاسق",
  "فاسقة",
  "فاسقه",
  "منحرف",
  "منحرفة",
  "منحرفه",
  "ابن القحبة",
  "ابن القحبه",
  "ابن الزنا",
  "ابن الزنه",
  "ابن الحرام",
  "ولد الحرام",
  "كس",
  "كسم",
  "طيز",
  "زُب",
  "زب",
  "عير",
  "عيري",
  "شعره",
  "شعرة",
  "شعرتي",
  "شوعرتي",

  "قضيب",
  "فرج",
  "خرا",
  "نجس",
  "وسخ",
  "قذر",
];

const DIACRITICS = /[\u064B-\u065F\u0670]/g;
const TATWEEL = /\u0640/g;
const WORD_CHAR_CLASS = "\\p{L}\\p{N}";

function buildLooseArabicRegex(word) {
  const normalized = word.replace(DIACRITICS, "").replace(TATWEEL, "");
  const compactLength = normalized.replace(/\s+/g, "").length;
  const isShortWord = compactLength <= 3;
  const sep = isShortWord
    ? "[\\u064B-\\u065F\\u0670\\u0640]*"
    : "[\\s\\u064B-\\u065F\\u0670\\u0640]*";
  const letters = Array.from(normalized).map((ch) => {
    if (/\s/.test(ch)) return "\\s+";
    return ch.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  });
  const body = letters.join(sep);
  return new RegExp(`(^|[^${WORD_CHAR_CLASS}])(${body})(?=$|[^${WORD_CHAR_CLASS}])`, "gu");
}

function maskArabicProfanity(text) {
  if (!text || typeof text !== "string") return text;
  let result = text;
  for (const bad of ARABIC_BAD_WORDS) {
    const regex = buildLooseArabicRegex(bad);
    result = result.replace(regex, (match, prefix, badWord) => {
      return `${prefix}${"*".repeat(badWord.length)}`;
    });
  }
  return result;
}

module.exports = {
  maskArabicProfanity,
  ARABIC_BAD_WORDS,
};
