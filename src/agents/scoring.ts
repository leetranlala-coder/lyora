import type { LeadAnalysis, LeadTemperature } from "../domain/types.js";
import type { Signals } from "./signals.js";

/**
 * Lead score = deterministic evidence + AI judgement.
 *
 * - The deterministic part rewards concrete behaviour (asking price, asking how to pay...)
 *   and sets a FLOOR: explicit buying intent can't be talked down by the model.
 * - The AI part (analysis.ai_score) captures nuance keywords miss.
 * - A clear "no" or stop request caps the score.
 */

export interface ScoreBreakdown {
  deterministic: number;
  floor: number;
  ai: number;
  final: number;
  temperature: LeadTemperature;
  reasons: string[];
}

export function scoreLead(
  s: Signals,
  analysis: LeadAnalysis,
  inboundCount: number,
  thresholds: { hot: number; veryHot: number },
): ScoreBreakdown {
  const reasons: string[] = [];
  let det = 5;
  let floor = 0;

  // engagement: more back-and-forth = warmer, capped
  det += Math.min(inboundCount, 5) * 2;

  // WARM evidence
  if (s.sharedGoal || s.painPoints.length || s.lifeContext.length || analysis.main_goal) {
    det += 15;
    floor = Math.max(floor, 26);
    reasons.push("shared goals/situation/pain points");
  }
  if (s.includedAsk) {
    det += 10;
    floor = Math.max(floor, 30);
    reasons.push("asked what's included");
  }
  if (s.beginner || s.nailTech) det += 3;

  // HOT evidence
  const hot: [boolean, string][] = [
    [s.priceAsk, "asked price"],
    [s.paymentPlanAsk, "asked about payment plans"],
    [s.kitAsk, "asked about kits/products"],
    [s.startDateAsk, "asked about start dates"],
    [s.comparing, "comparing offers"],
  ];
  for (const [hit, why] of hot) {
    if (hit) {
      det += 12;
      floor = Math.max(floor, thresholds.hot);
      reasons.push(why);
    }
  }

  // VERY HOT evidence
  if (s.readyToBuy) {
    det += 35;
    floor = Math.max(floor, thresholds.veryHot + 4);
    reasons.push("explicit intent to buy");
  }
  if (s.wantsCall) {
    det += 25;
    floor = Math.max(floor, thresholds.veryHot);
    reasons.push("wants a call");
  }

  det = clamp(det, 0, 100);
  const ai = clamp(Math.round(analysis.ai_score), 0, 100);
  let final = Math.max(floor, Math.round(det * 0.5 + ai * 0.5));

  if (analysis.said_no || s.saidNo) {
    final = Math.min(final, 15);
    reasons.push("declined");
  }
  if (analysis.asked_to_stop || s.askedToStop) {
    final = 0;
    reasons.push("asked to stop");
  }
  final = clamp(final, 0, 100);

  return { deterministic: det, floor, ai, final, temperature: temperatureFor(final, thresholds), reasons };
}

export function temperatureFor(score: number, t: { hot: number; veryHot: number }): LeadTemperature {
  if (score >= t.veryHot) return "very_hot";
  if (score >= t.hot) return "hot";
  if (score >= 26) return "warm";
  return "cold";
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
}
