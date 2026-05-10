// ==========================================================================
// Item 1: i18n configuration — i18next + react-i18next
// Supports: English (en), Hindi (hi) — add more in locales/ folder
//
// NOTE: If i18next is not installed yet, this module gracefully
// falls through and the app will work without translations.
// Install: npm install i18next react-i18next i18next-browser-languagedetector
// ==========================================================================

const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English', nativeName: 'English', flag: '🇺🇸' },
  { code: 'hi', name: 'Hindi', nativeName: 'हिन्दी', flag: '🇮🇳' },
]

let i18nInstance = null

try {
  const i18n = await import('i18next')
  const { initReactI18next } = await import('react-i18next')
  const LanguageDetector = (await import('i18next-browser-languagedetector')).default

  const en = (await import('./locales/en.json')).default
  const hi = (await import('./locales/hi.json')).default

  i18n.default
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
      resources: {
        en: { translation: en },
        hi: { translation: hi },
      },
      fallbackLng: 'en',
      supportedLngs: SUPPORTED_LANGUAGES.map((l) => l.code),
      interpolation: {
        escapeValue: false,
      },
      detection: {
        order: ['localStorage', 'navigator', 'htmlTag'],
        lookupLocalStorage: 'fa_language',
        caches: ['localStorage'],
      },
      react: {
        useSuspense: false,
      },
    })

  i18nInstance = i18n.default
} catch (e) {
  // i18next not installed yet — app will work without translations.
  console.info('[i18n] i18next not installed. Run: npm install i18next react-i18next i18next-browser-languagedetector')
}

export { SUPPORTED_LANGUAGES }
export default i18nInstance
