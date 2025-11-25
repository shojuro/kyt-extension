/**
 * Main Orchestrator for Synthetic Data Generation
 *
 * Coordinates generation of NER, Entity Linking, and Reranking datasets
 * with quality sampling workflow
 */

import { generateNERDataset } from './generate-ner-dataset.js';
import { generateLinkingDataset } from './generate-linking-dataset.js';
import { generateRerankingDataset } from './generate-reranking-dataset.js';
import { assessQuality } from './lib/validation.js';
import fs from 'fs/promises';
import readline from 'readline';

/**
 * 6-Step Quality Sampling Workflow
 */
export async function generateSyntheticData(options = {}) {
  const {
    nerCount = 10000,
    linkingCount = 10000,
    rerankingCount = 5000,
    sampleSize = 50,
    outputDir = 'data'
  } = options;

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║        🧬 SYNTHETIC DATA GENERATION ORCHESTRATOR 🧬          ║
║                                                              ║
║  Phase 1: Quality Sampling (${sampleSize} examples per dataset)       ║
║  Phase 2: User Review & Approval                            ║
║  Phase 3: Full-Scale Generation                             ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);

  console.log(`📊 Target Volumes:`);
  console.log(`   - NER: ${nerCount.toLocaleString()} examples`);
  console.log(`   - Entity Linking: ${linkingCount.toLocaleString()} examples`);
  console.log(`   - Reranking: ${rerankingCount.toLocaleString()} examples`);
  console.log(`   - Total: ${(nerCount + linkingCount + rerankingCount).toLocaleString()} examples\n`);

  // ============================================
  // STEP 1: Generate Quality Samples
  // ============================================
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📝 STEP 1: GENERATING QUALITY SAMPLES (${sampleSize} each)`);
  console.log(`${'═'.repeat(60)}\n`);

  const sampleResults = {
    ner: null,
    linking: null,
    reranking: null
  };

  try {
    // NER Samples
    console.log(`\n🧬 Generating NER samples...`);
    const nerResult = await generateNERDataset({
      count: sampleSize,
      outputPath: `${outputDir}/samples/ner-sample.json`,
      datasetName: 'ner-sample'
    });
    sampleResults.ner = nerResult;

    // Entity Linking Samples
    console.log(`\n🔗 Generating Entity Linking samples...`);
    const linkingResult = await generateLinkingDataset({
      count: sampleSize,
      outputPath: `${outputDir}/samples/linking-sample.json`,
      datasetName: 'linking-sample'
    });
    sampleResults.linking = linkingResult;

    // Reranking Samples
    console.log(`\n🎯 Generating Reranking samples...`);
    const rerankingResult = await generateRerankingDataset({
      count: sampleSize,
      outputPath: `${outputDir}/samples/reranking-sample.json`,
      datasetName: 'reranking-sample'
    });
    sampleResults.reranking = rerankingResult;

  } catch (error) {
    console.error(`\n❌ Fatal error during sample generation:`, error);
    return {
      success: false,
      phase: 'sampling',
      error: error.message
    };
  }

  // ============================================
  // STEP 2: Quality Assessment
  // ============================================
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📊 STEP 2: QUALITY ASSESSMENT`);
  console.log(`${'═'.repeat(60)}\n`);

  const qualityReports = {};

  try {
    // Load and assess each sample
    const nerSamples = JSON.parse(await fs.readFile(`${outputDir}/samples/ner-sample.json`, 'utf-8'));
    const linkingSamples = JSON.parse(await fs.readFile(`${outputDir}/samples/linking-sample.json`, 'utf-8'));
    const rerankingSamples = JSON.parse(await fs.readFile(`${outputDir}/samples/reranking-sample.json`, 'utf-8'));

    qualityReports.ner = assessQuality(nerSamples, 'ner');
    qualityReports.linking = assessQuality(linkingSamples, 'linking');
    qualityReports.reranking = assessQuality(rerankingSamples, 'reranking');

    // Display quality reports
    console.log(`\n🧬 NER Quality Report:`);
    console.log(`   ✅ Pass Rate: ${qualityReports.ner.passRate}`);
    console.log(`   📏 Avg Text Length: ${qualityReports.ner.avgTextLength} chars`);
    console.log(`   🏷️  Unique Entities: ${qualityReports.ner.uniqueEntities}`);
    console.log(`   ❌ Failed: ${qualityReports.ner.failed}`);

    console.log(`\n🔗 Entity Linking Quality Report:`);
    console.log(`   ✅ Pass Rate: ${qualityReports.linking.passRate}`);
    console.log(`   📏 Avg Context Length: ${qualityReports.linking.avgTextLength} chars`);
    console.log(`   🏷️  Unique Entities: ${qualityReports.linking.uniqueEntities}`);
    console.log(`   ❌ Failed: ${qualityReports.linking.failed}`);

    console.log(`\n🎯 Reranking Quality Report:`);
    console.log(`   ✅ Pass Rate: ${qualityReports.reranking.passRate}`);
    console.log(`   📏 Avg Passage Length: ${qualityReports.reranking.avgTextLength} chars`);
    console.log(`   ❌ Failed: ${qualityReports.reranking.failed}`);

    // Check if quality meets threshold (95%)
    const allPassRates = [
      parseFloat(qualityReports.ner.passRate),
      parseFloat(qualityReports.linking.passRate),
      parseFloat(qualityReports.reranking.passRate)
    ];

    const minPassRate = Math.min(...allPassRates);
    if (minPassRate < 95.0) {
      console.log(`\n⚠️  WARNING: Quality below 95% threshold (minimum: ${minPassRate.toFixed(1)}%)`);
      console.log(`   Consider adjusting prompts or validation rules before proceeding.\n`);
    }

  } catch (error) {
    console.error(`\n❌ Error during quality assessment:`, error);
    return {
      success: false,
      phase: 'quality_assessment',
      error: error.message
    };
  }

  // ============================================
  // STEP 3: User Review & Approval
  // ============================================
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`👀 STEP 3: USER REVIEW`);
  console.log(`${'═'.repeat(60)}\n`);

  console.log(`Sample files saved to:`);
  console.log(`   - ${outputDir}/samples/ner-sample.json`);
  console.log(`   - ${outputDir}/samples/linking-sample.json`);
  console.log(`   - ${outputDir}/samples/reranking-sample.json\n`);

  console.log(`📋 Total Sample Cost: $${(
    sampleResults.ner.cost +
    sampleResults.linking.cost +
    sampleResults.reranking.cost
  ).toFixed(4)}\n`);

  // Interactive approval (only in interactive mode)
  if (options.autoApprove) {
    console.log(`✅ Auto-approved (--approve flag)\n`);
  } else if (process.stdin.isTTY) {
    const approved = await promptUserApproval();
    if (!approved) {
      console.log(`\n❌ Generation cancelled by user.\n`);
      return {
        success: false,
        phase: 'user_approval',
        message: 'User declined to proceed with full generation'
      };
    }
  } else {
    console.log(`⚠️  Non-interactive mode: Skipping user approval prompt`);
    console.log(`   Use --approve flag to auto-approve in CI/CD\n`);
  }

  // ============================================
  // STEP 4: Full-Scale Generation
  // ============================================
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`🚀 STEP 4: FULL-SCALE GENERATION`);
  console.log(`${'═'.repeat(60)}\n`);

  const fullResults = {
    ner: null,
    linking: null,
    reranking: null
  };

  try {
    // NER Full Dataset
    console.log(`\n🧬 Generating NER dataset (${nerCount.toLocaleString()} examples)...`);
    fullResults.ner = await generateNERDataset({
      count: nerCount,
      outputPath: `${outputDir}/ner-dataset.json`,
      datasetName: 'ner'
    });

    // Entity Linking Full Dataset
    console.log(`\n🔗 Generating Entity Linking dataset (${linkingCount.toLocaleString()} examples)...`);
    fullResults.linking = await generateLinkingDataset({
      count: linkingCount,
      outputPath: `${outputDir}/linking-dataset.json`,
      datasetName: 'linking'
    });

    // Reranking Full Dataset
    console.log(`\n🎯 Generating Reranking dataset (${rerankingCount.toLocaleString()} examples)...`);
    fullResults.reranking = await generateRerankingDataset({
      count: rerankingCount,
      outputPath: `${outputDir}/reranking-dataset.json`,
      datasetName: 'reranking'
    });

  } catch (error) {
    console.error(`\n❌ Fatal error during full generation:`, error);
    return {
      success: false,
      phase: 'full_generation',
      error: error.message,
      partialResults: fullResults
    };
  }

  // ============================================
  // STEP 5: Final Validation
  // ============================================
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`✅ STEP 5: FINAL VALIDATION`);
  console.log(`${'═'.repeat(60)}\n`);

  try {
    // Load and validate final datasets
    const nerFinal = JSON.parse(await fs.readFile(`${outputDir}/ner-dataset.json`, 'utf-8'));
    const linkingFinal = JSON.parse(await fs.readFile(`${outputDir}/linking-dataset.json`, 'utf-8'));
    const rerankingFinal = JSON.parse(await fs.readFile(`${outputDir}/reranking-dataset.json`, 'utf-8'));

    const finalQuality = {
      ner: assessQuality(nerFinal, 'ner'),
      linking: assessQuality(linkingFinal, 'linking'),
      reranking: assessQuality(rerankingFinal, 'reranking')
    };

    console.log(`🧬 NER Final: ${finalQuality.ner.valid}/${nerFinal.length} valid (${finalQuality.ner.passRate})`);
    console.log(`🔗 Linking Final: ${finalQuality.linking.valid}/${linkingFinal.length} valid (${finalQuality.linking.passRate})`);
    console.log(`🎯 Reranking Final: ${finalQuality.reranking.valid}/${rerankingFinal.length} valid (${finalQuality.reranking.passRate})\n`);

  } catch (error) {
    console.error(`\n⚠️  Warning: Final validation failed:`, error.message);
    console.log(`   Datasets were generated but validation could not be completed.\n`);
  }

  // ============================================
  // STEP 6: Summary Report
  // ============================================
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`📊 STEP 6: FINAL SUMMARY`);
  console.log(`${'═'.repeat(60)}\n`);

  const totalCost = (
    sampleResults.ner.cost +
    sampleResults.linking.cost +
    sampleResults.reranking.cost +
    fullResults.ner.cost +
    fullResults.linking.cost +
    fullResults.reranking.cost
  );

  const totalExamples = (
    fullResults.ner.count +
    fullResults.linking.count +
    fullResults.reranking.count
  );

  console.log(`✨ Generation Complete!`);
  console.log(`\n📈 Statistics:`);
  console.log(`   - Total Examples: ${totalExamples.toLocaleString()}`);
  console.log(`   - NER: ${fullResults.ner.count.toLocaleString()} examples`);
  console.log(`   - Entity Linking: ${fullResults.linking.count.toLocaleString()} examples`);
  console.log(`   - Reranking: ${fullResults.reranking.count.toLocaleString()} examples`);
  console.log(`\n💰 Cost Breakdown:`);
  console.log(`   - Sampling Phase: $${(
    sampleResults.ner.cost +
    sampleResults.linking.cost +
    sampleResults.reranking.cost
  ).toFixed(4)}`);
  console.log(`   - Full Generation: $${(
    fullResults.ner.cost +
    fullResults.linking.cost +
    fullResults.reranking.cost
  ).toFixed(4)}`);
  console.log(`   - Total Cost: $${totalCost.toFixed(4)}`);
  console.log(`   - Cost Per Example: $${(totalCost / totalExamples).toFixed(6)}`);
  console.log(`\n📁 Output Files:`);
  console.log(`   - ${outputDir}/ner-dataset.json (${fullResults.ner.count.toLocaleString()} examples)`);
  console.log(`   - ${outputDir}/linking-dataset.json (${fullResults.linking.count.toLocaleString()} examples)`);
  console.log(`   - ${outputDir}/reranking-dataset.json (${fullResults.reranking.count.toLocaleString()} examples)`);
  console.log(`\n📊 Cost Tracking Files:`);
  console.log(`   - ${outputDir}/ner-cost-tracking.json`);
  console.log(`   - ${outputDir}/linking-cost-tracking.json`);
  console.log(`   - ${outputDir}/reranking-cost-tracking.json\n`);

  // Save summary report
  const summaryReport = {
    timestamp: new Date().toISOString(),
    configuration: {
      nerCount,
      linkingCount,
      rerankingCount,
      sampleSize
    },
    sampling: {
      ner: sampleResults.ner,
      linking: sampleResults.linking,
      reranking: sampleResults.reranking
    },
    full: {
      ner: fullResults.ner,
      linking: fullResults.linking,
      reranking: fullResults.reranking
    },
    totals: {
      examples: totalExamples,
      cost: totalCost,
      costPerExample: totalCost / totalExamples
    }
  };

  await fs.writeFile(
    `${outputDir}/generation-summary.json`,
    JSON.stringify(summaryReport, null, 2)
  );

  console.log(`💾 Summary saved to: ${outputDir}/generation-summary.json\n`);

  return {
    success: true,
    phase: 'complete',
    summary: summaryReport
  };
}

/**
 * Prompt user for approval (interactive mode only)
 */
async function promptUserApproval() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question('Proceed with full-scale generation? (yes/no): ', (answer) => {
      rl.close();
      const normalized = answer.toLowerCase().trim();
      resolve(normalized === 'yes' || normalized === 'y');
    });
  });
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
  // Parse CLI arguments
  const args = process.argv.slice(2);
  const options = {
    nerCount: 10000,
    linkingCount: 10000,
    rerankingCount: 5000,
    sampleSize: 50,
    outputDir: 'data',
    autoApprove: false
  };

  // Simple argument parsing
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ner-count' && args[i + 1]) {
      options.nerCount = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--linking-count' && args[i + 1]) {
      options.linkingCount = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--reranking-count' && args[i + 1]) {
      options.rerankingCount = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--sample-size' && args[i + 1]) {
      options.sampleSize = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--output-dir' && args[i + 1]) {
      options.outputDir = args[i + 1];
      i++;
    } else if (args[i] === '--approve') {
      options.autoApprove = true;
    } else if (args[i] === '--help') {
      console.log(`
Usage: node scripts/generate-synthetic-data.js [options]

Options:
  --ner-count <n>          Number of NER examples (default: 10000)
  --linking-count <n>      Number of Entity Linking examples (default: 10000)
  --reranking-count <n>    Number of Reranking examples (default: 5000)
  --sample-size <n>        Number of samples per dataset for quality check (default: 50)
  --output-dir <path>      Output directory (default: 'data')
  --approve                Auto-approve generation (skip user prompt)
  --help                   Show this help message

Examples:
  # Generate with defaults (25K total)
  node scripts/generate-synthetic-data.js

  # Generate smaller dataset for testing
  node scripts/generate-synthetic-data.js --ner-count 100 --linking-count 100 --reranking-count 50

  # Custom output directory
  node scripts/generate-synthetic-data.js --output-dir ./my-data

Environment Variables:
  OPENAI_API_KEY          Required: Your OpenAI API key
`);
      process.exit(0);
    }
  }

  // Run orchestrator
  const result = await generateSyntheticData(options);

  if (!result.success) {
    console.error(`\n❌ Generation failed at phase: ${result.phase}`);
    if (result.error) {
      console.error(`   Error: ${result.error}`);
    }
    process.exit(1);
  }

  process.exit(0);
}
