/**
 * Deterministic signal detection over what the LEAD wrote.
 *
 * These rules are a safety net, not the brain: the LLM analysis does the nuanced reading,
 * but anything safety-critical (stop requests, refunds, disputes, medical questions,
 * explicit buying intent) is also caught here so it never depends on a model alone.
 */

export interface Signals {
  askedToStop: boolean;
  saidNo: boolean;
  angry: boolean;
  refund: boolean;
  dispute: boolean;
  complaint: boolean;
  medical: boolean;
  legal: boolean;
  tax: boolean;
  discountRequest: boolean;
  customPricing: boolean;
  wantsLee: boolean;
  claimsPurchased: boolean;
  clientBooking: boolean;
  possibleMinor: boolean;
  oneToOneEnquiry: boolean;
  priceAsk: boolean;
  paymentPlanAsk: boolean;
  cannotAfford: boolean;
  unsureValue: boolean;
  wantsCheaper: boolean;
  kitAsk: boolean;
  hasProducts: boolean;
  noProducts: boolean;
  declinesKit: boolean;
  beginner: boolean;
  nailTech: boolean;
  readyToBuy: boolean;
  wantsCall: boolean;
  startDateAsk: boolean;
  includedAsk: boolean;
  comparing: boolean;
  sharedGoal: boolean;
  painPoints: string[];
  lifeContext: string[];
  goals: string[];
}

const R = {
  askedToStop:
    /(^\s*stop\s*[.!]*\s*$|\bstop (messaging|texting|contacting|sending|dm'?ing)\b|\bplease stop\b|\bunsubscribe\b|\bleave me alone\b|\b(don'?t|do not) (message|contact|text|dm) me\b|\bremove me\b|\bstop spamming\b)/i,
  saidNo:
    /(^\s*(no|nah|nope)\s*[.!]*\s*$|\bno thanks?\b|\bno thank you\b|\bnot interested\b|\bnot for me\b|\bi'?ll pass\b|\bi'?ve decided not\b|\bdecided against\b|\bmaybe (another|next) time\b|\bnot right now\b|\bi'?m (good|ok|okay),? thanks?\b|\bi don'?t want (it|to)\b)/i,
  angry: /\b(scam|scammer|rip ?off|disgusting|wtf|ridiculous|furious|so angry|pissed|worst|unacceptable|joke of a)\b/i,
  refund: /\b(refund|money back|want my money)\b/i,
  dispute: /\b(chargeback|charge back|dispute|reverse the (payment|charge)|paypal claim|bank (claim|reversal))\b/i,
  complaint: /\b(complain|complaint|not happy with|disappointed (with|in)|never (received|got)|haven'?t (received|got)|still waiting for my|doesn'?t work|not working)\b/i,
  medical:
    /\b(allerg\w*|reaction|infect\w*|fung(us|al)|pregnan\w*|breastfeeding|eczema|dermatitis|rash|burning|swell\w*|blister\w*|medical|doctor|asthma|fumes? (make|made) me)\b/i,
  legal: /\b(legal|lawyer|solicitor|contract|sue|lawsuit|insurance|licen[cs]e|licensing|regulation|council approval)\b/i,
  tax: /\b(tax|abn|gst|accountant|deduct\w*)\b/i,
  discountRequest:
    /\b(discount|coupon|promo ?code|discount code|special price|price match|cheaper price|(can|could) you do (it|me|that) (for|cheaper)|any deals?|mates? rates?)\b/i,
  customPricing: /\b(custom (price|package|quote)|group (price|booking|rate)|price for (two|2|both)|bulk|bundle deal|private (session|training) price)\b/i,
  wantsLee:
    /\b(speak|talk|chat) (to|with) (lee|you|a (real )?person|someone|a human)\b|\breal person\b|\b(is this|are you) (a )?(bot|ai|automated|real)\b|\bis this lee\b/i,
  claimsPurchased:
    /\b(i (just )?(paid|enrolled|enrolled|purchased|bought|signed up|joined)|just paid|payment (has )?(gone|went) through|i'?ve (paid|enrolled|purchased|bought|signed up))\b/i,
  clientBooking:
    /\b(book (me )?in|book an appointment|nail appointment|an appointment|do my nails|get my nails done|available for a set|any (spots|availability|openings)|have (a |any )?(spot|availability|opening)s?|can i get (a set|infills|a fill)|infill appointment)\b/i,
  possibleMinor:
    /\b(i'?m|im|i am) (1[0-7])\b|\b(1[0-7]) ?(yo|y\/o|years? old)\b|\byear (9|10|11|12)\b|\b(in|at) high ?school\b|\bstill (at|in) school\b|\bwace\b/i,
  oneToOneEnquiry:
    /(?<!\d)1 ?(:|-|on|to) ?1(?!\d)|\b(one[\s-]on[\s-]one|in[\s-]person|private training|train(ing)? with you|come to (your|the) (salon|studio)|luxe foundations|signature mentorship|nail art mastery)\b/i,
  priceAsk: /\b(how much|price|pricing|cost|costs|investment|fee|fees)\b|\$/i,
  paymentPlanAsk:
    /\b(payment ?plans?|instal+ments?|afterpay|zip ?pay|pay (it )?off|split (the |it )?(payments?|cost)?|weekly payments?|pay weekly|pay in parts|pay over time)\b/i,
  cannotAfford:
    /\b(can'?t afford|cannot afford|couldn'?t afford|money is (really |super |so )?tight|tight on money|no money|broke|struggling (financially|with money)|between jobs|lost my job|on centrelink|single income)\b/i,
  unsureValue: /\b(worth it|is it worth|that'?s (a lot|expensive|so expensive|too expensive|pricey)|too expensive|bit expensive|so expensive|out of my budget)\b/i,
  wantsCheaper: /\b(anything cheaper|cheaper option|just the basics|smaller (option|package)|cheapest|something cheaper|lower price)\b/i,
  kitAsk: /\b(kit|what products|which products|what do i need( to buy)?|products do i need|what (lamp|gels?|brand)|supplies|equipment|starter)\b/i,
  hasProducts:
    /\b(i (already )?(have|own|got) (all |most of )?(my |the )?(own )?(products|kit|setup|set up|lamp|gels?|stuff|supplies))\b|\balready (have|own|got) (a |my |the )?(kit|products|setup|lamp|everything)\b/i,
  noProducts: /\b(no products|don'?t have any(thing| products| stuff)?|starting from (scratch|zero|nothing)|nothing at all|don'?t own any|have nothing)\b/i,
  declinesKit: /\b((don'?t|do not) (want|need) (a |the |any )?kit|no kit|without (a |the )?kit|just the course)\b/i,
  beginner:
    /\b(beginner|never done (nails|it)|complete(ly)? new|no experience|starting from (scratch|zero)|just (do )?my own nails|do my own nails|total newbie|brand new to)\b/i,
  nailTech:
    /\b(i'?m a (nail )?tech|nail tech|my clients|i do nails|been doing nails|doing nails (for|since)|my salon|already (trained|qualified)|did (a|another) course|from home salon|i'?m qualified|my bookings)\b/i,
  readyToBuy:
    /\b(how do i (pay|join|enrol|enroll|sign up|buy|book)|send (me )?(the )?link|i want to (join|enrol|enroll|buy|sign up|start|book)|i'?m ready|can i start (now|today)|where do i (pay|sign up)|take my money|sign me up|i'?ll take it|let'?s do it|i'?m in)\b/i,
  wantsCall: /\b((can|could) (we|i) (have a |jump on a |book a )?(call|chat|talk|facetime|zoom)|book (a |in a )?call|phone call|facetime|zoom call|call me)\b/i,
  startDateAsk: /\b(when (does|can|do) (it|i|we) start|start date|next (intake|course|date)|available dates|how soon can i)\b/i,
  includedAsk: /\b(what'?s included|what do (i|you) get|what does it (include|cover)|what'?s in (it|the)|modules|what will i learn|what do you teach)\b/i,
  comparing: /\b(difference between|compare|which (one|course|option|package) (is|should|would)|vs\.?|versus)\b/i,
};

const PAIN: [string, RegExp][] = [
  ["lifting / retention", /\b(lift(ing|s)?|retention|pop(ping)? off|fall(ing)? off|chip(ping)?|don'?t last|won'?t last)\b/i],
  ["speed", /\b(too slow|so slow|slow|speed|takes? me (hours|forever|so long))\b/i],
  ["nail art", /\b(nail art|designs?|art work)\b/i],
  ["confidence", /\b(confidence|confident|nervous|scared|anxious|imposter)\b/i],
  ["getting clients", /\b(no clients|get(ting)? clients|find clients|bookings|booked out|quiet)\b/i],
  ["instagram / content", /\b(instagram|content|posting|reels|followers)\b/i],
  ["pricing their services", /\b(how (to|do i) price|charge (clients|for)|undercharg\w*|my prices)\b/i],
  ["shaping / structure", /\b(shap(e|ing)|structure|apex|thick|bulky)\b/i],
  ["removals / refills", /\b(removals?|refills?|infills?|soak ?off)\b/i],
  ["product confusion", /\b(so many products|don'?t know what to buy|confused about products|which brand)\b/i],
];

const LIFE: [string, RegExp][] = [
  ["stay-at-home mum", /\b(stay[- ]at[- ]home (mum|mom)|sahm|home with (the|my) kids)\b/i],
  ["single mum", /\b(single (mum|mom|parent))\b/i],
  ["student", /\b(student|studying|uni|university|tafe|school)\b/i],
  ["unhappy in job", /\b(hate my job|unhappy (in|at) (my )?(job|work)|sick of my job|hate work)\b/i],
  ["employed full-time", /\b(work full[- ]time|full[- ]time job|9 ?to ?5|9-5)\b/i],
  ["employed part-time", /\b(part[- ]time)\b/i],
];

const GOALS: [string, RegExp][] = [
  ["side income", /\b(side hustle|side income|extra (income|money|cash)|on the side)\b/i],
  ["full-time nails", /\b(full[- ]time (nails|income|tech)|do (nails|this) full[- ]time|make it my career|career)\b/i],
  ["work from home", /\b(from home|home salon|work for myself|own business|be my own boss)\b/i],
  ["do own nails", /\b(do my own nails|for myself|my own nails)\b/i],
  ["upskill", /\b(upskill|level up|get better|improve my)\b/i],
];

export function detectSignals(text: string): Signals {
  const t = text ?? "";
  const test = (re: RegExp) => re.test(t);
  const hits = (list: [string, RegExp][]) => list.filter(([, re]) => re.test(t)).map(([label]) => label);
  const goals = hits(GOALS);
  return {
    askedToStop: test(R.askedToStop),
    saidNo: test(R.saidNo),
    angry: test(R.angry),
    refund: test(R.refund),
    dispute: test(R.dispute),
    complaint: test(R.complaint),
    medical: test(R.medical),
    legal: test(R.legal),
    tax: test(R.tax),
    discountRequest: test(R.discountRequest),
    customPricing: test(R.customPricing),
    wantsLee: test(R.wantsLee),
    claimsPurchased: test(R.claimsPurchased),
    clientBooking: test(R.clientBooking) && !test(R.wantsCall),
    possibleMinor: test(R.possibleMinor),
    oneToOneEnquiry: test(R.oneToOneEnquiry),
    priceAsk: test(R.priceAsk),
    paymentPlanAsk: test(R.paymentPlanAsk),
    cannotAfford: test(R.cannotAfford),
    unsureValue: test(R.unsureValue),
    wantsCheaper: test(R.wantsCheaper),
    kitAsk: test(R.kitAsk),
    hasProducts: test(R.hasProducts),
    noProducts: test(R.noProducts),
    declinesKit: test(R.declinesKit),
    beginner: test(R.beginner),
    nailTech: test(R.nailTech),
    readyToBuy: test(R.readyToBuy),
    wantsCall: test(R.wantsCall),
    startDateAsk: test(R.startDateAsk),
    includedAsk: test(R.includedAsk),
    comparing: test(R.comparing),
    sharedGoal: goals.length > 0,
    painPoints: hits(PAIN),
    lifeContext: hits(LIFE),
    goals,
  };
}

/** Signals across a set of lead messages (OR of booleans, union of lists). */
export function detectSignalsAcross(texts: string[]): Signals {
  const all = texts.map(detectSignals);
  const base = detectSignals("");
  const out = { ...base } as Signals;
  for (const s of all) {
    for (const k of Object.keys(base) as (keyof Signals)[]) {
      const v = s[k];
      if (typeof v === "boolean") (out[k] as boolean) = (out[k] as boolean) || v;
      else (out[k] as string[]) = [...new Set([...(out[k] as string[]), ...(v as string[])])];
    }
  }
  return out;
}

/** Signals that require Lee immediately, with a reason and priority. */
export function sensitiveHandoff(s: Signals): { reason: string; priority: "normal" | "high" | "urgent" } | null {
  if (s.dispute) return { reason: "payment dispute / chargeback mentioned", priority: "urgent" };
  if (s.refund) return { reason: "refund request", priority: "urgent" };
  if (s.angry) return { reason: "lead is upset/angry", priority: "urgent" };
  if (s.complaint) return { reason: "complaint", priority: "high" };
  if (s.medical) return { reason: "medical / health question", priority: "high" };
  if (s.legal) return { reason: "legal question", priority: "normal" };
  if (s.tax) return { reason: "tax / business-registration question", priority: "normal" };
  if (s.customPricing) return { reason: "custom pricing request", priority: "normal" };
  if (s.discountRequest) return { reason: "discount request", priority: "normal" };
  if (s.wantsLee) return { reason: "asked to speak to lee directly", priority: "high" };
  if (s.possibleMinor) return { reason: "possibly under 18 — no selling, lee to handle", priority: "normal" };
  if (s.oneToOneEnquiry) return { reason: "1:1 / in-person training enquiry (1:1 is full until 2027)", priority: "high" };
  if (s.clientBooking) return { reason: "nail appointment request — appointments are booked by lee in DMs, not a course lead", priority: "normal" };
  return null;
}
