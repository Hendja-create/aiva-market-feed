import test from "node:test";
import assert from "node:assert/strict";
import { scoreReportJudgment } from "../src/judgment-score.js";

test("judgment rubric rewards evidence, numerical findings, uncertainty and testable recommendations", () => {
  const report = {
    executive_summary: "Les résultats hors échantillon restent incertains, simulés et affectés par les coûts.",
    market_regime: "Régime non déterminé faute de données suffisantes.",
    overall_confidence: "medium",
    mathematical_findings: Array.from({length:4},(_,i)=>({finding:"Constat "+i,evidence:"Sur 42 transactions, le profit factor est 0.8 et l'expectancy est négative après coûts.",confidence:"high"})),
    strategy_reviews: Array.from({length:4},(_,i)=>({strategy:"Stratégie "+i,evidence:"Résultat OOS sur 40 trades, expectancy négative.",main_risk:"Biais de sélection et coûts variables."})),
    recommendations: Array.from({length:5},(_,i)=>({rationale:"La validation reste incertaine faute de données indépendantes.",validation_test:"Tester sur 100 observations indépendantes avec coûts préenregistrés."})),
    data_quality: [{issue:"Données limitées",impact:"Échantillon incomplet",severity:"high"}],
    prohibited_conclusions:["Ne pas conclure à une rentabilité réelle."]
  };
  const score = scoreReportJudgment(report, {candles:{capped:true},ticks:{capped:true}});
  assert.equal(score.rubric_version,"1.0");
  assert.ok(score.score >= 70 && score.score <= 100);
  assert.equal(score.dimensions.evidence_quality.max,30);
  assert.ok(score.deductions.some(x=>x.includes("plafond")));
  assert.match(score.methodology,/pas la justesse prédictive/);
});

test("judgment rubric penalizes missing source coverage and empty reasoning", () => {
  const score = scoreReportJudgment({}, {});
  assert.ok(score.score < 35);
  assert.equal(score.grade,"weak");
  assert.equal(score.dimensions.data_integrity.score,11);
  assert.ok(score.deductions.length >= 3);
});
