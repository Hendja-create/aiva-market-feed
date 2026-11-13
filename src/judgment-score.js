const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const words = value => typeof value === "string" ? value.trim().split(/\s+/).filter(Boolean).length : 0;

/**
 * Deterministic rubric. It scores the report's evidence discipline and auditability,
 * not whether its market predictions are correct. It never delegates its own grade to the LLM.
 */
export function scoreReportJudgment(report, sourceCounts = {}) {
  const findings = Array.isArray(report?.mathematical_findings) ? report.mathematical_findings : [];
  const reviews = Array.isArray(report?.strategy_reviews) ? report.strategy_reviews : [];
  const recs = Array.isArray(report?.recommendations) ? report.recommendations : [];
  const quality = Array.isArray(report?.data_quality) ? report.data_quality : [];
  const forbidden = Array.isArray(report?.prohibited_conclusions) ? report.prohibited_conclusions : [];
  const evidenceBackedFindings = findings.filter(x => words(x.evidence) >= 12).length;
  const evidenceBackedReviews = reviews.filter(x => words(x.evidence) >= 12 && words(x.main_risk) >= 5).length;
  const testableRecs = recs.filter(x => words(x.validation_test) >= 8 && words(x.rationale) >= 5).length;

  const proof = clamp(Math.round((Math.min(evidenceBackedFindings, 4) / 4) * 18 +
    (Math.min(evidenceBackedReviews, 4) / 4) * 12), 0, 30);
  const math = clamp(Math.round((Math.min(findings.length, 4) / 4) * 8 +
    (findings.filter(x => /\d/.test(x.evidence || "")).length / Math.max(1, findings.length)) * 10 +
    (findings.filter(x => ["high", "medium", "low"].includes(x.confidence)).length / Math.max(1, findings.length)) * 7), 0, 25);
  const caveatText = [report?.executive_summary, report?.market_regime, ...quality.map(x => x.issue + " " + x.impact),
    ...forbidden].join(" ").toLowerCase();
  const caveatSignals = ["échantillon", "incert", "hors échantillon", "simul", "biais", "coût", "donnée", "validation"]
    .filter(term => caveatText.includes(term)).length;
  const uncertainty = clamp(Math.round(Math.min(20, caveatSignals * 2.5) +
    (report?.overall_confidence === "low" || report?.overall_confidence === "medium" ? 4 : 0)), 0, 20);
  const capped = Object.values(sourceCounts || {}).some(v => v?.capped === true);
  const missingCoverage = !sourceCounts || Object.keys(sourceCounts).length === 0;
  const dataIntegrity = clamp(15 - (capped ? 7 : 0) - (missingCoverage ? 4 : 0) -
    (quality.filter(x => x.severity === "high").length > 0 ? 1 : 0), 0, 15);
  const actionability = clamp(Math.round((Math.min(testableRecs, 5) / 5) * 10), 0, 10);
  const total = proof + math + uncertainty + dataIntegrity + actionability;
  const deductions = [];
  if (capped) deductions.push("Des sources de données ont atteint leur plafond d'extraction.");
  if (missingCoverage) deductions.push("Les compteurs de couverture des sources ne sont pas disponibles.");
  if (findings.length < 2) deductions.push("Trop peu de constats mathématiques pour un audit robuste.");
  if (testableRecs < 2) deductions.push("Moins de deux recommandations disposent d'un test de validation exploitable.");
  return {
    rubric_version: "1.0",
    score: total,
    grade: total >= 90 ? "excellent" : total >= 80 ? "good" : total >= 65 ? "moderate" : "weak",
    dimensions: {
      evidence_quality: { score: proof, max: 30 },
      mathematical_rigor: { score: math, max: 25 },
      uncertainty_handling: { score: uncertainty, max: 20 },
      data_integrity: { score: dataIntegrity, max: 15 },
      actionability: { score: actionability, max: 10 }
    },
    deductions,
    methodology: "Barème déterministe appliqué côté serveur aux éléments structurés du rapport et aux compteurs de couverture. Ce score mesure la discipline du jugement et sa traçabilité, pas la justesse prédictive ni la rentabilité."
  };
}
