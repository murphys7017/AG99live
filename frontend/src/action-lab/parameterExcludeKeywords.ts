import { computed, ref } from "vue";

const STORAGE_KEY = "ag99live.parameter_exclude_keywords";
const DEFAULT_KEYWORDS = ["hair", "bind", "physics", "phy"];

function normalizeKeywordText(value: string): string[] {
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const item of value.split(/[\r\n,，]+/)) {
    const keyword = item.trim().toLowerCase();
    if (!keyword || seen.has(keyword)) {
      continue;
    }
    seen.add(keyword);
    keywords.push(keyword);
  }
  return keywords;
}

function loadParameterExcludeKeywords(): string[] {
  if (typeof window === "undefined") {
    return DEFAULT_KEYWORDS;
  }
  try {
    const rawValue = window.localStorage.getItem(STORAGE_KEY);
    if (!rawValue) {
      return DEFAULT_KEYWORDS;
    }
    const keywords = normalizeKeywordText(rawValue);
    return keywords.length ? keywords : DEFAULT_KEYWORDS;
  } catch {
    return DEFAULT_KEYWORDS;
  }
}

export function useParameterExcludeKeywords() {
  const excludedParameterKeywordsText = ref(loadParameterExcludeKeywords().join("\n"));
  const parameterExcludeKeywords = computed(() =>
    normalizeKeywordText(excludedParameterKeywordsText.value),
  );

  function persistParameterExcludeKeywords(): void {
    const keywords = parameterExcludeKeywords.value;
    excludedParameterKeywordsText.value = keywords.join("\n");
    try {
      window.localStorage.setItem(STORAGE_KEY, keywords.join("\n"));
    } catch {
      // Storage unavailable (e.g., Safari private mode, quota exceeded)
    }
  }

  function resetParameterExcludeKeywords(): void {
    excludedParameterKeywordsText.value = DEFAULT_KEYWORDS.join("\n");
    persistParameterExcludeKeywords();
  }

  return {
    DEFAULT_KEYWORDS,
    excludedParameterKeywordsText,
    parameterExcludeKeywords,
    persistParameterExcludeKeywords,
    resetParameterExcludeKeywords,
  };
}
