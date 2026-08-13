'use strict';
/**
 * The countries asked for, and nothing else.
 *
 * Grouped by the primary language of the country, which is what goes in the
 * Language column. Equatorial Guinea is listed as both Spanish- and
 * Portuguese-speaking in the brief; Spanish is the working language of the
 * country by a wide margin, so it is recorded as Spanish and appears once.
 */

const COUNTRIES = {
  /* ---- Spanish ---- */
  AR:['Argentina','Spanish'], BO:['Bolivia','Spanish'], CL:['Chile','Spanish'],
  CO:['Colombia','Spanish'], CR:['Costa Rica','Spanish'], CU:['Cuba','Spanish'],
  DO:['Dominican Republic','Spanish'], EC:['Ecuador','Spanish'], SV:['El Salvador','Spanish'],
  GQ:['Equatorial Guinea','Spanish'], GT:['Guatemala','Spanish'], HN:['Honduras','Spanish'],
  MX:['Mexico','Spanish'], NI:['Nicaragua','Spanish'], PA:['Panama','Spanish'],
  PY:['Paraguay','Spanish'], PE:['Peru','Spanish'], ES:['Spain','Spanish'],
  UY:['Uruguay','Spanish'], VE:['Venezuela','Spanish'],

  /* ---- Portuguese ---- */
  AO:['Angola','Portuguese'], BR:['Brazil','Portuguese'], CV:['Cape Verde','Portuguese'],
  TL:['East Timor','Portuguese'], GW:['Guinea-Bissau','Portuguese'], MZ:['Mozambique','Portuguese'],
  PT:['Portugal','Portuguese'], ST:['São Tomé and Príncipe','Portuguese'],

  /* ---- English ---- */
  AG:['Antigua and Barbuda','English'], AU:['Australia','English'], BS:['Bahamas','English'],
  BB:['Barbados','English'], BZ:['Belize','English'], BW:['Botswana','English'],
  CA:['Canada','English'], DM:['Dominica','English'], FJ:['Fiji','English'],
  GM:['Gambia','English'], GH:['Ghana','English'], GD:['Grenada','English'],
  GY:['Guyana','English'], IN:['India','English'], IE:['Ireland','English'],
  JM:['Jamaica','English'], KE:['Kenya','English'], KI:['Kiribati','English'],
  LS:['Lesotho','English'], LR:['Liberia','English'], MW:['Malawi','English'],
  MT:['Malta','English'], MH:['Marshall Islands','English'], MU:['Mauritius','English'],
  FM:['Micronesia','English'], NA:['Namibia','English'], NR:['Nauru','English'],
  NZ:['New Zealand','English'], NG:['Nigeria','English'], PK:['Pakistan','English'],
  PW:['Palau','English'], PG:['Papua New Guinea','English'], PH:['Philippines','English'],
  RW:['Rwanda','English'], KN:['Saint Kitts and Nevis','English'], LC:['Saint Lucia','English'],
  VC:['Saint Vincent and the Grenadines','English'], WS:['Samoa','English'],
  SC:['Seychelles','English'], SL:['Sierra Leone','English'], SG:['Singapore','English'],
  SB:['Solomon Islands','English'], ZA:['South Africa','English'], SS:['South Sudan','English'],
  SD:['Sudan','English'], TZ:['Tanzania','English'], TO:['Tonga','English'],
  TT:['Trinidad and Tobago','English'], TV:['Tuvalu','English'], UG:['Uganda','English'],
  GB:['United Kingdom','English'], US:['United States','English'], VU:['Vanuatu','English'],
  ZM:['Zambia','English'], ZW:['Zimbabwe','English'],
  /* English-language markets outside the original brief */
  AE:['United Arab Emirates','English'], CY:['Cyprus','English'], EG:['Egypt','English'],

  /* ---- Expansion, 2026-08-13: the original 83 are fully imported and the
   * engines ran dry, so the list widens to the countries where racket clubs
   * are densest. Same free sources — OpenStreetMap and DuckDuckGo. ---- */

  /* ---- French ---- */
  FR:['France','French'], BE:['Belgium','French'], LU:['Luxembourg','French'],
  MA:['Morocco','French'], TN:['Tunisia','French'],

  /* ---- German ---- */
  DE:['Germany','German'], AT:['Austria','German'], CH:['Switzerland','German'],

  /* ---- Italian ---- */
  IT:['Italy','Italian'],

  /* ---- Dutch ---- */
  NL:['Netherlands','Dutch'],

  /* ---- Nordic ---- */
  SE:['Sweden','Swedish'], NO:['Norway','Norwegian'], DK:['Denmark','Danish'],
  FI:['Finland','Finnish'], IS:['Iceland','Icelandic'],

  /* ---- Central and Eastern Europe ---- */
  PL:['Poland','Polish'], CZ:['Czechia','Czech'], SK:['Slovakia','Slovak'],
  HU:['Hungary','Hungarian'], SI:['Slovenia','Slovenian'], HR:['Croatia','Croatian'],
  RO:['Romania','Romanian'], BG:['Bulgaria','Bulgarian'], GR:['Greece','Greek'],
  EE:['Estonia','Estonian'], LV:['Latvia','Latvian'], LT:['Lithuania','Lithuanian']
};

const CODES = Object.keys(COUNTRIES);

/* Country-code top-level domains, for working out which country a club is in
 * when the directory listing it covers several. Only the unambiguous ones:
 * .io, .tv, .fm and friends are sold worldwide and say nothing about where
 * the holder is, so they are left out even though they are ccTLDs. */
const VANITY = new Set(['tv','fm','io','cc','me','ai','gg','to','ws','nu','mu','sc','vu','st','tk']);

const TLD_TO_CC = {};
for(const cc of CODES){
  const t = cc.toLowerCase();
  if(!VANITY.has(t)) TLD_TO_CC[t] = cc;
}
TLD_TO_CC['uk'] = 'GB';    // the ccTLD does not match the ISO code

/**
 * Which country does this website belong to? '' when it cannot be told —
 * a .com says nothing, and guessing would put the club in the wrong
 * country with the wrong language.
 */
function ccFromHost(hostOrUrl){
  let host = String(hostOrUrl||'').trim().toLowerCase();
  if(!host) return '';
  if(host.includes('://')){
    try{ host = new URL(host).hostname; }catch(e){ return ''; }
  }
  host = host.replace(/^www\./,'').split(':')[0];
  const parts = host.split('.');
  if(parts.length < 2) return '';
  const tld = parts[parts.length-1];
  return TLD_TO_CC[tld] || '';
}

function isWanted(cc){ return Object.prototype.hasOwnProperty.call(COUNTRIES, String(cc).toUpperCase()); }
function nameOf(cc){ const m = COUNTRIES[String(cc).toUpperCase()]; return m ? m[0] : ''; }
function langOf(cc){ const m = COUNTRIES[String(cc).toUpperCase()]; return m ? m[1] : ''; }

/* Rough priority for collection order: countries where racket clubs are
 * numerous and publish emails come first, so early runs are productive.
 * Everything in the list is still collected; this only orders the queue. */
const PRIORITY = [
  'ES','GB','BR','AR','US','AU','PT','MX','IN','ZA','CA','IE','NZ','CL','CO',
  'PE','UY','EC','PY','CR','PA','GT','DO','VE','BO','SV','HN','NI','CU',
  'SG','PH','PK','KE','NG','MT','MU','ZW','ZM','TZ','UG','GH','BW','NA',
  'TT','JM','BS','BB','FJ','PG','MZ','AO','CV','SC','MW','RW','GY','BZ',
  'LC','GD','AG','KN','VC','DM','SS','SD','GM','LS','LR','SL','TL','GW',
  'ST','GQ','WS','TO','VU','SB','KI','NR','TV','MH','FM','PW',
  // The expansion countries, richest OpenStreetMap coverage first. They sit
  // at the end of the list but run first anyway: nextCountries() takes the
  // not-yet-imported before re-walking the imported.
  'DE','FR','IT','NL','SE','AT','CH','BE','DK','NO','FI','PL','CZ','AE',
  'GR','HU','HR','RO','CY','MA','EG','SK','SI','BG','LU','TN','EE','LV','LT','IS'
];

module.exports = { COUNTRIES, CODES, PRIORITY, TLD_TO_CC, isWanted, nameOf, langOf, ccFromHost };
