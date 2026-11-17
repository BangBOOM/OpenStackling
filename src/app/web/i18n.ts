import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import zh from './locales/zh.json';
import en from './locales/en.json';

i18n.on('languageChanged', (language) => {
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
});
void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: { zh: { translation: zh }, en: { translation: en } },
    supportedLngs: ['zh', 'en'],
    fallbackLng: 'en',
    load: 'languageOnly',
    initAsync: false,
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'stackling.language',
      caches: ['localStorage'],
      convertDetectedLanguage: (language) => language.split('-')[0],
    },
    interpolation: { escapeValue: false },
  });
export default i18n;
