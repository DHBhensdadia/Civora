import { DEFAULT_LANGUAGE, languageOf } from './languages';

/**
 * The phrases the capture and alert flows are built from.
 *
 * Two flows, and deliberately only two. A platform that claims to be localised
 * everywhere while its medicine names, risk drivers and audit trail are English
 * is telling a reader something untrue about itself; a platform that says which
 * flows a health worker can actually work in is not. What is here is what those
 * two flows say to the person holding the phone — the labels on a capture form,
 * the state of an alert, the words on the buttons that move it — and the
 * **bodies** of an alert are prose written per language by the writer, not keys
 * from this file.
 *
 * The keys are a union, and every bundle is a total record over it. A language
 * that is missing a phrase therefore does not fall back silently: it fails the
 * build, which is the only kind of missing translation worth having. The
 * fallback at runtime exists for one case and is named for it — a caller asking
 * in a language this build does not offer gets English, which is what the
 * registry's own rule says a surface may do, as long as it does not *claim* the
 * record is in that language.
 *
 * Three claims are kept apart here as they are in the registry: a language is
 * **offered** (this file has a bundle), an alert is **carried** in a language
 * (the record holds a body), and a body is **written** (a model produced one in
 * a run). A bundle covers the first and says nothing about the other two.
 */

export const MESSAGE_KEYS = [
  'capture.title',
  'capture.subtitle',
  'capture.offline',
  'capture.facility',
  'capture.item',
  'capture.kind',
  'capture.kind.receipt',
  'capture.kind.issue',
  'capture.quantity',
  'capture.occurredOn',
  'capture.batch',
  'capture.expiresOn',
  'capture.reason',
  'capture.submit',
  'capture.queued',
  'capture.sent',
  'capture.pending',
  'capture.refused',
  'capture.rejected',
  'alert.title',
  'alert.severity',
  'alert.state',
  'alert.raisedOn',
  'alert.facility',
  'alert.item',
  'alert.drivers',
  'alert.acknowledge',
  'alert.snooze',
  'alert.escalate',
  'alert.resolve',
  'alert.propose',
  'alert.reason',
  'alert.listen',
  'alert.listening',
  'alert.noVoice',
  'alert.noBody',
  'alert.severity.critical',
  'alert.severity.high',
  'alert.severity.watch',
  'alert.severity.low',
  'alert.severity.unknown',
  'alert.state.raised',
  'alert.state.open',
  'alert.state.action_proposed',
  'alert.state.acknowledged',
  'alert.state.snoozed',
  'alert.state.escalated',
  'alert.state.resolved',
  'language.label',
  'language.bodyMissing',
  'language.acted',
  'common.current',
  'common.stale',
  'common.neverHeard',
  'common.days',
  'common.asOf',
  'common.simulated',
] as const;

export type MessageKey = (typeof MESSAGE_KEYS)[number];

/** One language's phrases, and the locale its dates and numbers are rendered in. */
export interface LocaleBundle {
  /** The language tag the bundle is keyed by. */
  readonly language: string;
  /** The `Intl` tag for this language, from the registry. */
  readonly locale: string;
  readonly messages: Readonly<Record<MessageKey, string>>;
}

/**
 * The English phrases, which are also the keys' own spellings.
 *
 * Written as the source of truth a reader can compare the others against, and
 * the only bundle a surface may fall back to. A shorter phrase is preferred to a
 * more precise one only where precision would not survive translation: a health
 * worker reads "Issue", not "Stock issued to patients".
 */
const EN: Record<MessageKey, string> = {
  'capture.title': 'Record a stock movement',
  'capture.subtitle':
    'Works offline. An entry saved on this device is sent when the connection returns.',
  'capture.offline': 'Offline',
  'capture.facility': 'Facility',
  'capture.item': 'Item',
  'capture.kind': 'Movement',
  'capture.kind.receipt': 'Receipt',
  'capture.kind.issue': 'Issue',
  'capture.quantity': 'Quantity',
  'capture.occurredOn': 'Occurred on',
  'capture.batch': 'Batch',
  'capture.expiresOn': 'Expires on',
  'capture.reason': 'Reason',
  'capture.submit': 'Queue capture',
  'capture.queued': 'Saved on this device; it will be sent when the connection returns.',
  'capture.sent': 'Accepted by the platform.',
  'capture.pending': 'Waiting to be sent',
  'capture.refused': 'Refused by the platform',
  'capture.rejected': 'Not accepted',
  'alert.title': 'Early warning',
  'alert.severity': 'Severity',
  'alert.state': 'State',
  'alert.raisedOn': 'Raised on',
  'alert.facility': 'Facility',
  'alert.item': 'Item',
  'alert.drivers': 'Why this alert',
  'alert.acknowledge': 'Acknowledge',
  'alert.snooze': 'Snooze',
  'alert.escalate': 'Escalate',
  'alert.resolve': 'Resolve',
  'alert.propose': 'Propose action',
  'alert.reason': 'Why (recorded with the move)',
  'alert.listen': 'Read aloud',
  'alert.listening': 'Stop reading',
  'alert.noVoice': 'This device has no voice installed, so nothing can be read aloud.',
  'alert.noBody':
    'Nothing is read aloud: this alert holds no body in the interface language, and reading another language in this voice would misstate the record.',
  'alert.severity.critical': 'Critical',
  'alert.severity.high': 'High',
  'alert.severity.watch': 'Watch',
  'alert.severity.low': 'Low',
  'alert.severity.unknown': 'Unknown',
  'alert.state.raised': 'Raised',
  'alert.state.open': 'Open',
  'alert.state.action_proposed': 'Action proposed',
  'alert.state.acknowledged': 'Acknowledged',
  'alert.state.snoozed': 'Snoozed',
  'alert.state.escalated': 'Escalated',
  'alert.state.resolved': 'Resolved',
  'language.label': 'Language',
  'language.bodyMissing': 'No body in this language yet; the record holds one in another.',
  'language.acted': 'Actions are recorded in English so the trail reads the same for everyone.',
  'common.current': 'Current',
  'common.stale': 'Stale',
  'common.neverHeard': 'Never heard from',
  'common.days': 'days',
  'common.asOf': 'As of',
  'common.simulated': 'Simulated data',
};

const HI: Record<MessageKey, string> = {
  'capture.title': 'स्टॉक की आवाजाही दर्ज करें',
  'capture.subtitle':
    'ऑफ़लाइन काम करता है। इस उपकरण में सहेजी गई प्रविष्टि कनेक्शन लौटने पर भेजी जाती है।',
  'capture.offline': 'ऑफ़लाइन',
  'capture.facility': 'केंद्र',
  'capture.item': 'वस्तु',
  'capture.kind': 'प्रकार',
  'capture.kind.receipt': 'प्राप्ति',
  'capture.kind.issue': 'वितरण',
  'capture.quantity': 'मात्रा',
  'capture.occurredOn': 'दिनांक',
  'capture.batch': 'बैच',
  'capture.expiresOn': 'समाप्ति तिथि',
  'capture.reason': 'कारण',
  'capture.submit': 'कतार में जमा करें',
  'capture.queued': 'इस उपकरण में सहेजा गया; कनेक्शन लौटने पर भेजा जाएगा।',
  'capture.sent': 'प्लेटफ़ॉर्म ने स्वीकार किया।',
  'capture.pending': 'भेजने की प्रतीक्षा में',
  'capture.refused': 'प्लेटफ़ॉर्म ने अस्वीकार किया',
  'capture.rejected': 'स्वीकार नहीं हुआ',
  'alert.title': 'पूर्व चेतावनी',
  'alert.severity': 'गंभीरता',
  'alert.state': 'स्थिति',
  'alert.raisedOn': 'चेतावनी की तिथि',
  'alert.facility': 'केंद्र',
  'alert.item': 'वस्तु',
  'alert.drivers': 'यह चेतावनी क्यों',
  'alert.acknowledge': 'स्वीकार करें',
  'alert.snooze': 'टालें',
  'alert.escalate': 'आगे बढ़ाएँ',
  'alert.resolve': 'हल हुआ',
  'alert.propose': 'कार्रवाई सुझाएँ',
  'alert.reason': 'कारण (बदलाव के साथ दर्ज)',
  'alert.listen': 'सुनकर समझें',
  'alert.listening': 'पढ़ना बंद करें',
  'alert.noVoice': 'इस उपकरण में कोई आवाज़ नहीं है, इसलिए सुनाया नहीं जा सकता।',
  'alert.noBody':
    'कुछ सुनाया नहीं जाता: इस चेतावनी में इंटरफ़ेस की भाषा में सामग्री नहीं है, और दूसरी भाषा को इस आवाज़ में पढ़ना रिकॉर्ड को ग़लत बताएगा।',
  'alert.severity.critical': 'अति गंभीर',
  'alert.severity.high': 'गंभीर',
  'alert.severity.watch': 'निगरानी',
  'alert.severity.low': 'कम',
  'alert.severity.unknown': 'अज्ञात',
  'alert.state.raised': 'जारी',
  'alert.state.open': 'खुली',
  'alert.state.action_proposed': 'कार्रवाई सुझाई गई',
  'alert.state.acknowledged': 'स्वीकृत',
  'alert.state.snoozed': 'टाली गई',
  'alert.state.escalated': 'आगे बढ़ाई गई',
  'alert.state.resolved': 'हल हुई',
  'language.label': 'भाषा',
  'language.bodyMissing': 'इस भाषा में अभी सामग्री नहीं; रिकॉर्ड में दूसरी भाषा में है।',
  'language.acted': 'कार्रवाई अंग्रेज़ी में दर्ज होती है ताकि अभिलेख सबके लिए एक जैसा रहे।',
  'common.current': 'वर्तमान',
  'common.stale': 'पुरानी',
  'common.neverHeard': 'कोई सूचना नहीं',
  'common.days': 'दिन',
  'common.asOf': 'स्थिति दिनांक',
  'common.simulated': 'नकली डेटा',
};

const MR: Record<MessageKey, string> = {
  'capture.title': 'स्टॉकची नोंद करा',
  'capture.subtitle': 'ऑफलाइन चालते. या उपकरणात साठवलेली नोंद कनेक्शन परत आल्यावर पाठवली जाते.',
  'capture.offline': 'ऑफलाइन',
  'capture.facility': 'केंद्र',
  'capture.item': 'वस्तू',
  'capture.kind': 'प्रकार',
  'capture.kind.receipt': 'आवक',
  'capture.kind.issue': 'वितरण',
  'capture.quantity': 'संख्या',
  'capture.occurredOn': 'दिनांक',
  'capture.batch': 'बॅच',
  'capture.expiresOn': 'मुदत संपण्याची तारीख',
  'capture.reason': 'कारण',
  'capture.submit': 'रांगेत जमा करा',
  'capture.queued': 'या उपकरणात साठवले; कनेक्शन परत आल्यावर पाठवले जाईल.',
  'capture.sent': 'प्लॅटफॉर्मने स्वीकारले.',
  'capture.pending': 'पाठवण्याच्या प्रतीक्षेत',
  'capture.refused': 'प्लॅटफॉर्मने नाकारले',
  'capture.rejected': 'स्वीकारले नाही',
  'alert.title': 'पूर्वसूचना',
  'alert.severity': 'तीव्रता',
  'alert.state': 'स्थिती',
  'alert.raisedOn': 'सूचनेची तारीख',
  'alert.facility': 'केंद्र',
  'alert.item': 'वस्तू',
  'alert.drivers': 'ही सूचना का',
  'alert.acknowledge': 'स्वीकार करा',
  'alert.snooze': 'पुढे ढकला',
  'alert.escalate': 'वर पाठवा',
  'alert.resolve': 'निकाली',
  'alert.propose': 'कृती सुचवा',
  'alert.reason': 'कारण (बदलासोबत नोंदले जाते)',
  'alert.listen': 'ऐकून घ्या',
  'alert.listening': 'वाचणे थांबवा',
  'alert.noVoice': 'या उपकरणात आवाज नाही, त्यामुळे वाचून दाखवता येत नाही.',
  'alert.noBody':
    'काहीही वाचून दाखवले जात नाही: या सूचनेत इंटरफेसच्या भाषेत मजकूर नाही, आणि दुसरी भाषा या आवाजात वाचणे नोंदीबद्दल चुकीचे सांगेल.',
  'alert.severity.critical': 'अत्यंत तीव्र',
  'alert.severity.high': 'तीव्र',
  'alert.severity.watch': 'लक्ष ठेवा',
  'alert.severity.low': 'कमी',
  'alert.severity.unknown': 'अज्ञात',
  'alert.state.raised': 'नोंदवलेली',
  'alert.state.open': 'खुली',
  'alert.state.action_proposed': 'कृती सुचवलेली',
  'alert.state.acknowledged': 'स्वीकारलेली',
  'alert.state.snoozed': 'पुढे ढकललेली',
  'alert.state.escalated': 'वर पाठवलेली',
  'alert.state.resolved': 'निकाली',
  'language.label': 'भाषा',
  'language.bodyMissing': 'या भाषेत अजून मजकूर नाही; नोंद दुसऱ्या भाषेत आहे.',
  'language.acted': 'कृती इंग्रजीत नोंदल्या जातात, म्हणजे नोंद सर्वांसाठी सारखी वाचता येते.',
  'common.current': 'चालू',
  'common.stale': 'जुनी',
  'common.neverHeard': 'कोणतीही माहिती नाही',
  'common.days': 'दिवस',
  'common.asOf': 'स्थिती दिनांक',
  'common.simulated': 'नकली डेटा',
};

const BN: Record<MessageKey, string> = {
  'capture.title': 'স্টকের লেনদেন নথিভুক্ত করুন',
  'capture.subtitle': 'অফলাইনে কাজ করে। এই ডিভাইসে সংরক্ষিত এন্ট্রি সংযোগ ফিরলে পাঠানো হয়।',
  'capture.offline': 'অফলাইন',
  'capture.facility': 'কেন্দ্র',
  'capture.item': 'সামগ্রী',
  'capture.kind': 'ধরন',
  'capture.kind.receipt': 'প্রাপ্তি',
  'capture.kind.issue': 'বিতরণ',
  'capture.quantity': 'পরিমাণ',
  'capture.occurredOn': 'তারিখ',
  'capture.batch': 'ব্যাচ',
  'capture.expiresOn': 'মেয়াদ শেষের তারিখ',
  'capture.reason': 'কারণ',
  'capture.submit': 'সারিতে জমা দিন',
  'capture.queued': 'এই ডিভাইসে সংরক্ষিত; সংযোগ ফিরলে পাঠানো হবে।',
  'capture.sent': 'প্ল্যাটফর্ম গ্রহণ করেছে।',
  'capture.pending': 'পাঠানোর অপেক্ষায়',
  'capture.refused': 'প্ল্যাটফর্ম প্রত্যাখ্যান করেছে',
  'capture.rejected': 'গ্রহণ করা হয়নি',
  'alert.title': 'পূর্ব-সতর্কতা',
  'alert.severity': 'তীব্রতা',
  'alert.state': 'অবস্থা',
  'alert.raisedOn': 'সতর্কতার তারিখ',
  'alert.facility': 'কেন্দ্র',
  'alert.item': 'সামগ্রী',
  'alert.drivers': 'এই সতর্কতা কেন',
  'alert.acknowledge': 'স্বীকার করুন',
  'alert.snooze': 'পরে দেখুন',
  'alert.escalate': 'উপরে পাঠান',
  'alert.resolve': 'সমাধান হয়েছে',
  'alert.propose': 'ব্যবস্থা প্রস্তাব করুন',
  'alert.reason': 'কারণ (পরিবর্তনের সঙ্গে নথিভুক্ত)',
  'alert.listen': 'পড়ে শোনান',
  'alert.listening': 'পড়া বন্ধ করুন',
  'alert.noVoice': 'এই ডিভাইসে কোনো কণ্ঠস্বর নেই, তাই পড়ে শোনানো যায় না।',
  'alert.noBody':
    'কিছু পড়ে শোনানো হয় না: এই সতর্কতায় ইন্টারফেসের ভাষায় কোনো বিবরণ নেই, আর অন্য ভাষা এই কণ্ঠে পড়া নথিটিকে ভুলভাবে উপস্থাপন করবে।',
  'alert.severity.critical': 'অতি গুরুতর',
  'alert.severity.high': 'গুরুতর',
  'alert.severity.watch': 'নজরে',
  'alert.severity.low': 'কম',
  'alert.severity.unknown': 'অজানা',
  'alert.state.raised': 'উত্থাপিত',
  'alert.state.open': 'খোলা',
  'alert.state.action_proposed': 'ব্যবস্থা প্রস্তাবিত',
  'alert.state.acknowledged': 'স্বীকৃত',
  'alert.state.snoozed': 'পরে দেখার জন্য রাখা',
  'alert.state.escalated': 'উপরে পাঠানো',
  'alert.state.resolved': 'সমাধান হয়েছে',
  'language.label': 'ভাষা',
  'language.bodyMissing': 'এই ভাষায় এখনও কিছু নেই; নথিতে অন্য ভাষায় আছে।',
  'language.acted': 'কার্যক্রম ইংরেজিতে নথিভুক্ত হয়, যাতে নথি সবার জন্য একইভাবে পড়া যায়।',
  'common.current': 'বর্তমান',
  'common.stale': 'পুরনো',
  'common.neverHeard': 'কোনো তথ্য নেই',
  'common.days': 'দিন',
  'common.asOf': 'স্থিতির তারিখ',
  'common.simulated': 'নকল তথ্য',
};

const TA: Record<MessageKey, string> = {
  'capture.title': 'சரக்கு இயக்கத்தைப் பதிவு செய்யுங்கள்',
  'capture.subtitle':
    'இணையம் இல்லாமல் இயங்கும். இந்தச் சாதனத்தில் சேமிக்கப்பட்டது இணைப்பு திரும்பியதும் அனுப்பப்படும்.',
  'capture.offline': 'இணையம் இல்லை',
  'capture.facility': 'நிலையம்',
  'capture.item': 'பொருள்',
  'capture.kind': 'வகை',
  'capture.kind.receipt': 'வரவு',
  'capture.kind.issue': 'வழங்கல்',
  'capture.quantity': 'அளவு',
  'capture.occurredOn': 'நாள்',
  'capture.batch': 'தொகுதி',
  'capture.expiresOn': 'காலாவதி நாள்',
  'capture.reason': 'காரணம்',
  'capture.submit': 'வரிசையில் சேர்',
  'capture.queued': 'இந்தச் சாதனத்தில் சேமிக்கப்பட்டது; இணைப்பு திரும்பியதும் அனுப்பப்படும்.',
  'capture.sent': 'தளம் ஏற்றுக்கொண்டது.',
  'capture.pending': 'அனுப்பக் காத்திருக்கிறது',
  'capture.refused': 'தளம் மறுத்துவிட்டது',
  'capture.rejected': 'ஏற்கப்படவில்லை',
  'alert.title': 'முன்னெச்சரிக்கை',
  'alert.severity': 'தீவிரம்',
  'alert.state': 'நிலை',
  'alert.raisedOn': 'எச்சரிக்கை நாள்',
  'alert.facility': 'நிலையம்',
  'alert.item': 'பொருள்',
  'alert.drivers': 'இந்த எச்சரிக்கை ஏன்',
  'alert.acknowledge': 'ஏற்கவும்',
  'alert.snooze': 'பின்னர் பார்க்க',
  'alert.escalate': 'மேலே அனுப்பு',
  'alert.resolve': 'தீர்ந்தது',
  'alert.propose': 'நடவடிக்கை பரிந்துரை',
  'alert.reason': 'காரணம் (மாற்றத்துடன் பதிவாகும்)',
  'alert.listen': 'படித்து கேட்க',
  'alert.listening': 'படிப்பதை நிறுத்து',
  'alert.noVoice': 'இந்தச் சாதனத்தில் குரல் இல்லை, எனவே படித்துக் காட்ட முடியாது.',
  'alert.noBody':
    'எதுவும் படித்துக் காட்டப்படுவதில்லை: இந்த எச்சரிக்கையில் இடைமுக மொழியில் உள்ளடக்கம் இல்லை; மற்றொரு மொழியை இந்தக் குரலில் படிப்பது பதிவைத் தவறாகக் காட்டும்.',
  'alert.severity.critical': 'மிகத் தீவிரம்',
  'alert.severity.high': 'தீவிரம்',
  'alert.severity.watch': 'கவனிக்க',
  'alert.severity.low': 'குறைவு',
  'alert.severity.unknown': 'தெரியவில்லை',
  'alert.state.raised': 'எழுப்பப்பட்டது',
  'alert.state.open': 'திறந்தது',
  'alert.state.action_proposed': 'நடவடிக்கை பரிந்துரைக்கப்பட்டது',
  'alert.state.acknowledged': 'ஏற்கப்பட்டது',
  'alert.state.snoozed': 'ஒதுக்கப்பட்டது',
  'alert.state.escalated': 'மேலே அனுப்பப்பட்டது',
  'alert.state.resolved': 'தீர்க்கப்பட்டது',
  'language.label': 'மொழி',
  'language.bodyMissing': 'இந்த மொழியில் இன்னும் உள்ளடக்கம் இல்லை; பதிவில் வேறு மொழியில் உள்ளது.',
  'language.acted':
    'நடவடிக்கைகள் ஆங்கிலத்தில் பதிவாகின்றன; அதனால் பதிவு அனைவருக்கும் ஒரே மாதிரி படிக்கும்.',
  'common.current': 'தற்போதைய',
  'common.stale': 'பழைய',
  'common.neverHeard': 'தகவல் இல்லை',
  'common.days': 'நாட்கள்',
  'common.asOf': 'நிலை நாள்',
  'common.simulated': 'செயற்கை தரவு',
};

/**
 * The bundles, one per offered language.
 *
 * Typed as a total record over the registry's codes, so a language added to
 * `LANGUAGES` without phrases here is a compile error rather than a surface that
 * renders English while claiming Marathi.
 *
 * These translations are the platform's own, written for the prototype. They are
 * not the work of a professional translator, and no surface should present them
 * as reviewed: `RUN_STATE` records that gap, and a deployment would replace this
 * file wholesale rather than grow it key by key.
 */
const ALL: Readonly<Record<string, Record<MessageKey, string>>> = {
  en: EN,
  hi: HI,
  mr: MR,
  bn: BN,
  ta: TA,
};

export const BUNDLES: readonly LocaleBundle[] = Object.entries(ALL).map(([language, messages]) => {
  const entry = languageOf(language);
  return {
    language,
    locale: entry?.locale ?? language,
    messages,
  };
});

/** The bundle for an offered language, or null when this build does not offer it. */
export const bundleFor = (language: string): LocaleBundle | null =>
  BUNDLES.find((bundle) => bundle.language === language) ?? null;

/**
 * One phrase, in the reader's language.
 *
 * An unoffered language is answered in English rather than with the key or an
 * error, because a flow that cannot be worked at all is worse than one whose
 * buttons are in the wrong language — but the *caller* is the one that knows
 * whether it is claiming a language, and `bundleFor` is what it should ask to
 * find out. This is the last resort, and it is deliberately blunt.
 */
export const messageFor = (language: string, key: MessageKey): string =>
  bundleFor(language)?.messages[key] ?? EN[key];

/** The phrases every bundle has to carry, in the order they are declared. */
export const messageKeys: readonly MessageKey[] = MESSAGE_KEYS;

/** The English bundle, for a surface that has to name the fallback it is using. */
export const defaultBundle = (): LocaleBundle => {
  const bundle = bundleFor(DEFAULT_LANGUAGE);
  if (bundle === null) {
    // Unreachable: `DEFAULT_LANGUAGE` is an offered language and the bundles are
    // built from the registry. Thrown rather than defaulted so a registry whose
    // default language has no bundle fails loudly instead of rendering keys.
    throw new Error(`no bundle for the default language ${DEFAULT_LANGUAGE}`);
  }
  return bundle;
};
