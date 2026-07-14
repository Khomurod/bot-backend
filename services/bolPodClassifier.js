/**
 * Classify a BOL/POD document as 'bol' | 'pod' | 'unrelated' | 'unclear'.
 *
 * Deterministic-first: the DataTruck OpenAPI exposes an authoritative document
 * type (bill_of_lading / proof_of_delivery), so classification is a metadata
 * lookup — the app's integrated AI is used only when that metadata cannot decide
 * (spec §5). Because the current source always carries a tracked type, the AI
 * fallback is effectively dormant and is OFF by default
 * (config.bolPodAiFallbackEnabled). It is fail-closed: any error/uncertainty
 * degrades to 'unclear', which follows the admin's uncertain-document policy and
 * is never auto-sent to a driver group.
 */
const config = require('../config/config');

const CLASSIFICATIONS = ['bol', 'pod', 'unrelated', 'unclear'];

/** Authoritative DataTruck document type → classification, or null if unknown. */
function classifyByMetadata(doc) {
  const t = doc?.fileType;
  if (t === 'bill_of_lading') return { classification: 'bol', source: 'datatruck_metadata' };
  if (t === 'proof_of_delivery') return { classification: 'pod', source: 'datatruck_metadata' };
  return null;
}

/**
 * @param {object} doc a document from datatruckDocumentHelpers.extractTrackedDocuments
 * @param {object} [opts]
 * @param {(doc:object)=>Promise<{classification:string,confidence?:number}>} [opts.classifyWithAi]
 *        optional vision classifier; only consulted when metadata is inconclusive
 *        AND config.bolPodAiFallbackEnabled is true.
 * @returns {Promise<{classification:string, source:string}>}
 */
async function classifyDocument(doc, opts = {}) {
  const byMeta = classifyByMetadata(doc);
  if (byMeta) return byMeta;

  if (config.bolPodAiFallbackEnabled && typeof opts.classifyWithAi === 'function') {
    try {
      const ai = await opts.classifyWithAi(doc);
      if (ai && CLASSIFICATIONS.includes(ai.classification)) {
        return { classification: ai.classification, source: 'ai_vision' };
      }
    } catch (err) {
      // Fail closed — never guess on an AI error.
      console.warn('[BOL/POD] AI classification failed, treating as unclear:', err.message);
    }
  }
  return { classification: 'unclear', source: 'undetermined' };
}

module.exports = { classifyDocument, classifyByMetadata, CLASSIFICATIONS };
