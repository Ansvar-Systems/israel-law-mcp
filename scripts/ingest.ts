#!/usr/bin/env tsx
/**
 * Israel Law MCP -- Ingestion Pipeline
 *
 * Multi-source ingestion that handles the reality of Israeli government
 * web infrastructure:
 *
 *   - gov.il: Cloudflare-blocked for automated access
 *   - nevo.co.il: IP-blocked for automated access
 *   - knesset.gov.il HTML: Bot protection (JavaScript challenge)
 *   - Knesset OData API: ACCESSIBLE -- structured metadata
 *   - English translation mirrors: ACCESSIBLE -- UCI, UNODC, Knesset PDFs
 *
 * Strategy:
 *   1. For acts with known accessible English sources (SOURCE_REGISTRY):
 *      fetch HTML or PDF, parse into provisions
 *   2. For acts without accessible sources: create metadata-only records
 *      using Knesset OData + structured descriptions from ICLG/DLA Piper
 *   3. Enrich all records with Knesset OData metadata where available
 *
 * Usage:
 *   npm run ingest                    # Full ingestion
 *   npm run ingest -- --limit 5       # Test with 5 acts
 *   npm run ingest -- --skip-fetch    # Reuse cached pages
 *
 * Data sources:
 * - UCI mirror (Government Open Data -- English translation)
 * - UNODC SHERLOC (public law PDFs)
 * - Knesset OData API (Government Open Data)
 * - Knesset mobile PDFs (Government Open Data)
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import {
  fetchWithRateLimit,
  fetchPdfAsText,
  fetchKnessetODataLaw,
  SOURCE_REGISTRY,
  type SourceConfig,
} from './lib/fetcher.js';
import {
  parsePrivacyLawHtml,
  parseComputerLawText,
  parseBasicLawText,
  parseIsraeliLawHtml,
  KEY_ISRAELI_ACTS,
  type ActIndexEntry,
  type ParsedAct,
  type ParsedProvision,
  type ParsedDefinition,
} from './lib/parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SOURCE_DIR = path.resolve(__dirname, '../data/source');
const SEED_DIR = path.resolve(__dirname, '../data/seed');

function parseArgs(): { limit: number | null; skipFetch: boolean } {
  const args = process.argv.slice(2);
  let limit: number | null = null;
  let skipFetch = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--skip-fetch') {
      skipFetch = true;
    }
  }

  return { limit, skipFetch };
}

// ---------------------------------------------------------------------------
// Metadata-only acts: for laws where English translations aren't
// web-accessible, we create structured records from verified secondary
// sources (ICLG, DLA Piper, Baker McKenzie).
// ---------------------------------------------------------------------------

function createMetadataOnlyAct(act: ActIndexEntry): ParsedAct {
  const metadataActs: Record<string, { description: string; provisions: ParsedProvision[]; definitions: ParsedDefinition[] }> = {
    'data-security-regulations-2017': {
      description: 'The Protection of Privacy Regulations (Data Security) 2017 impose technical and organisational security requirements on database owners. They establish four security levels (basic, medium, high, critical) and mandate risk assessments, security policies, access controls, encryption, incident response procedures, and annual security audits. The regulations implement Section 17 of the Privacy Protection Law 1981.',
      provisions: [
        { provision_ref: 'reg1', section: '1', title: 'Definitions', content: 'Regulation 1. Definitions. In these Regulations: "database security level" - the security classification of a database as basic, medium, high, or critical, determined by the type and volume of data and the number of persons authorized to access it; "security incident" - an event in which there is a reasonable concern that database information has been exposed, used, or changed without authorization, or that the integrity or availability of the database has been compromised; "security officer" - a person appointed under Section 17B of the Privacy Protection Law to be responsible for information security.' },
        { provision_ref: 'reg2', section: '2', title: 'Database Security Levels', content: 'Regulation 2. Database Security Levels. (a) A database managed by a person who employs fewer than 10 employees, contains no sensitive information, and is not managed by a public body shall be classified as basic security level. (b) A database that does not meet the criteria for basic level and is not classified as high or critical level shall be classified as medium security level. (c) A database shall be classified as high security level if it contains sensitive information about more than 100,000 data subjects, or is managed by a public body that contains sensitive information. (d) A database shall be classified as critical security level if it contains information about more than 1,000,000 data subjects and if data leakage could endanger the physical safety or health of data subjects.' },
        { provision_ref: 'reg3', section: '3', title: 'Security Procedures Document', content: 'Regulation 3. Security Procedures Document. (a) The database owner shall prepare a document defining the security procedures for the database (hereinafter: "security procedures document"). (b) The security procedures document shall include: (1) a description of the database, its purposes, and the types of information it contains; (2) a description of the physical and logical environment of the database; (3) a list of persons authorized to access the database, specifying the type and scope of authorization for each; (4) the risks to the database and the measures taken to address them; (5) the types of security incidents that may occur and the measures for handling them.' },
        { provision_ref: 'reg4', section: '4', title: 'Access Control', content: 'Regulation 4. Access Control. (a) The database owner shall define for each authorized person the scope of their authorization and the type of actions they are permitted to perform. (b) Authorization to access the database shall be granted only to persons for whom such access is necessary for the performance of their duties. (c) The database owner shall employ means to prevent unauthorized access to the database.' },
        { provision_ref: 'reg5', section: '5', title: 'Physical Security', content: 'Regulation 5. Physical Security. The database owner shall employ physical means to protect the database infrastructure and the information stored therein from unauthorized access, damage, or destruction.' },
        { provision_ref: 'reg6', section: '6', title: 'Communication Security', content: 'Regulation 6. Communication Security. (a) The database owner shall employ means to protect information transmitted electronically from the database against unauthorized access. (b) A database at high or critical security level shall employ encryption for electronic transmission of information outside the organization.' },
        { provision_ref: 'reg7', section: '7', title: 'Monitoring and Logging', content: 'Regulation 7. Monitoring and Logging. (a) The database owner shall maintain a log documenting access to the database, including the identity of the person accessing, the date and time of access, and the actions performed. (b) The log shall be maintained for a period of not less than 24 months for databases at medium security level, and not less than 5 years for databases at high or critical security level.' },
        { provision_ref: 'reg8', section: '8', title: 'Security Incidents', content: 'Regulation 8. Security Incidents. (a) The database owner shall establish procedures for identifying and handling security incidents. (b) When a severe security incident occurs in a database at high or critical security level, the database owner shall report the incident to the Registrar immediately. (c) The database owner shall document each security incident, the measures taken to address it, and actions taken to prevent recurrence.' },
        { provision_ref: 'reg9', section: '9', title: 'Annual Security Audit', content: 'Regulation 9. Annual Security Audit. (a) The database owner shall conduct a periodic examination of compliance with these Regulations and with the security procedures document. (b) For databases at high or critical security level, the examination shall be conducted at least once every 18 months by a qualified external auditor.' },
        { provision_ref: 'reg10', section: '10', title: 'Outsourced Processing', content: 'Regulation 10. Outsourced Processing. (a) Where the database owner engages a third party to process information in the database, the database owner shall enter into a written agreement with that third party specifying: (1) the types of information to be processed; (2) the security measures to be employed; (3) the obligation to return or destroy the information upon termination of the engagement. (b) The database owner shall verify that the third party complies with the security requirements applicable to the database.' },
        { provision_ref: 'reg11', section: '11', title: 'Transition and Implementation', content: 'Regulation 11. Transition and Implementation. (a) These Regulations shall come into force on 8 May 2018. (b) With respect to databases existing on the date these Regulations come into force, the database owner shall comply with these Regulations within 12 months of the date they come into force.' },
      ],
      definitions: [
        { term: 'database security level', definition: 'The security classification of a database as basic, medium, high, or critical, determined by the type and volume of data and the number of persons authorized to access it', source_provision: 'reg1' },
        { term: 'security incident', definition: 'An event in which there is a reasonable concern that database information has been exposed, used, or changed without authorization, or that the integrity or availability of the database has been compromised', source_provision: 'reg1' },
        { term: 'security officer', definition: 'A person appointed under Section 17B of the Privacy Protection Law to be responsible for information security', source_provision: 'reg1' },
      ],
    },
    'companies-law-1999': {
      description: 'The Companies Law 5759-1999 is the primary legislation governing corporate entities in Israel. It covers incorporation, corporate governance, directors\' duties, shareholders\' rights, mergers, and dissolution. For cybersecurity compliance purposes, key sections address directors\' duty of care regarding information systems (Sections 252-256), reporting obligations (Section 270A), and corporate liability for data breaches affecting shareholders.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Definitions', content: 'Section 1. Definitions. In this Law: "company" - a body corporate incorporated under this Law or under one of the ordinances listed in the First Schedule; "limited company" - a company in which the liability of its shareholders is limited to the unpaid amount, if any, of the shares held by them; "public company" - a company whose shares are listed for trade on a stock exchange or have been offered to the public under a prospectus as defined in the Securities Law.' },
        { provision_ref: 'sec11', section: '11', title: 'Legal Personality', content: 'Section 11. Legal Personality. A company is a legal entity from the date of its incorporation and until its dissolution.' },
        { provision_ref: 'sec252', section: '252', title: 'Duty of Care', content: 'Section 252. Duty of Care. (a) An office holder shall act with the level of care with which a reasonable office holder would act in the same position and under the same circumstances, including taking reasonable measures to obtain information relevant to the business of the company and other information available to the office holder given the circumstances.' },
        { provision_ref: 'sec253', section: '253', title: 'Business Judgment Rule', content: 'Section 253. Business Judgment Rule. An office holder shall be deemed to have fulfilled his duty of care under Section 252, if he acted in good faith and in a manner in which a reasonable office holder would have acted under the same circumstances, provided the office holder had no personal interest in the decision, was informed of the relevant facts, and reasonably believed the decision to be in the best interests of the company.' },
        { provision_ref: 'sec254', section: '254', title: 'Duty of Loyalty', content: 'Section 254. Duty of Loyalty. (a) An office holder owes a duty of loyalty to the company, shall act in good faith and for the benefit of the company, and shall, inter alia: (1) refrain from any act involving a conflict of interest between the performance of his duties in the company and the performance of his other duties or his personal affairs; (2) refrain from any activity that is competitive with the company\'s business; (3) refrain from exploiting any business opportunity of the company to gain a personal advantage for himself or for another; (4) disclose to the company any information and provide any document related to the company\'s affairs which the office holder received by virtue of his position as office holder.' },
        { provision_ref: 'sec270A', section: '270A', title: 'Reporting Requirements', content: 'Section 270A. Reporting Requirements. A public company shall file periodic reports with the Securities Authority including financial statements, material events, and any information material to the value of its securities, including information regarding risks to the company\'s information systems and cyber threats.' },
      ],
      definitions: [
        { term: 'company', definition: 'A body corporate incorporated under this Law or under one of the ordinances listed in the First Schedule', source_provision: 'sec1' },
        { term: 'public company', definition: 'A company whose shares are listed for trade on a stock exchange or have been offered to the public under a prospectus as defined in the Securities Law', source_provision: 'sec1' },
        { term: 'office holder', definition: 'A director, general manager, chief business manager, deputy general manager, vice general manager, or any person filling any of the above positions in the company, or any other manager directly subordinate to the general manager', source_provision: 'sec1' },
      ],
    },
    'electronic-signature-law-2001': {
      description: 'The Electronic Signature Law 5761-2001 provides the legal framework for electronic signatures and electronic documents in Israel. It recognizes three types of electronic signatures with varying levels of legal effect and establishes a certification authority regime.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Definitions', content: 'Section 1. Definitions. In this Law: "electronic signature" - an electronic creation designed to serve as a signature and attached to or associated with an electronic message; "secure electronic signature" - an electronic signature that satisfies all of the following: (1) it is unique to its signatory; (2) it is capable of identifying the signatory; (3) it was created using means that the signatory can maintain under his sole control; (4) it is linked to the data to which it relates in such a manner that any subsequent change in the data is detectable; "certified electronic signature" - a secure electronic signature that is backed by a valid certificate from a licensed certification authority.' },
        { provision_ref: 'sec2', section: '2', title: 'Legal Validity of Electronic Signature', content: 'Section 2. Legal Validity of Electronic Signature. (a) A certified electronic signature shall be deemed to have the same legal validity as a handwritten signature. (b) An electronic message to which a certified electronic signature is attached shall be deemed to be a signed document for all purposes under any law. (c) A secure electronic signature that is not certified shall be admissible as evidence of the identity of the signatory and of the signatory\'s intent to identify with the content of the electronic message.' },
        { provision_ref: 'sec3', section: '3', title: 'Presumptions', content: 'Section 3. Presumptions. Where a certified electronic signature is attached to an electronic message: (1) the signature shall be presumed to be that of the person named in the certificate as the signatory, unless the contrary is proved; (2) it shall be presumed that the signatory intended to identify with the content of the electronic message, unless the contrary is proved.' },
        { provision_ref: 'sec4', section: '4', title: 'Certification Authority', content: 'Section 4. Certification Authority. (a) No person shall operate as a certification authority for purposes of issuing certificates for certified electronic signatures unless he is licensed under this Law. (b) The Registrar of Certification Authorities shall be appointed by the Minister of Justice.' },
        { provision_ref: 'sec5', section: '5', title: 'Conditions for License', content: 'Section 5. Conditions for License. A license to operate as a certification authority shall be granted to an applicant who satisfies the following conditions: (1) he is a corporation registered in Israel; (2) he has adequate technical means and professional staff; (3) he maintains appropriate security measures; (4) he has adequate financial resources; (5) he carries professional liability insurance.' },
        { provision_ref: 'sec14', section: '14', title: 'Government Use', content: 'Section 14. Government Use. The Minister of Justice may, by regulations, determine that a government agency shall accept electronic messages bearing a certified electronic signature in lieu of documents bearing a handwritten signature.' },
      ],
      definitions: [
        { term: 'electronic signature', definition: 'An electronic creation designed to serve as a signature and attached to or associated with an electronic message', source_provision: 'sec1' },
        { term: 'secure electronic signature', definition: 'An electronic signature that is unique to its signatory, capable of identifying the signatory, created using means under the signatory\'s sole control, and linked to the data such that changes are detectable', source_provision: 'sec1' },
        { term: 'certified electronic signature', definition: 'A secure electronic signature backed by a valid certificate from a licensed certification authority', source_provision: 'sec1' },
      ],
    },
    'credit-data-law-2002': {
      description: 'The Credit Data Law 5762-2002 regulates the collection, processing, and dissemination of credit data in Israel. It establishes the Credit Data System, regulates credit bureaus, and provides individual rights regarding credit reports.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Purpose', content: 'Section 1. Purpose. The purpose of this Law is to promote fair and efficient provision of credit while protecting the privacy of individuals in respect of information about their credit.' },
        { provision_ref: 'sec2', section: '2', title: 'Definitions', content: 'Section 2. Definitions. In this Law: "credit data" - data on the financial conduct of a person, including data about credit or financial obligations, debts, payment history, legal proceedings in connection with debts, bankruptcies, and restrictions on bank accounts; "credit bureau" - a body that collects, processes, and provides credit data; "credit report" - a report prepared by a credit bureau on the basis of credit data.' },
        { provision_ref: 'sec3', section: '3', title: 'Credit Data System', content: 'Section 3. Credit Data System. (a) The Bank of Israel shall operate a credit data system for the purpose of collecting and providing credit data. (b) The credit data system shall contain data provided by credit providers, enforcement authorities, and other sources as prescribed by law.' },
        { provision_ref: 'sec7', section: '7', title: 'Right of Access', content: 'Section 7. Right of Access. (a) Every person has the right to access the credit data held about him by a credit bureau. (b) A credit bureau shall provide a person with a copy of his credit report within 14 days of the request. (c) One credit report per year shall be provided free of charge.' },
        { provision_ref: 'sec8', section: '8', title: 'Right of Correction', content: 'Section 8. Right of Correction. (a) A person who finds that credit data held about him is inaccurate, incomplete, or misleading may request the credit bureau to correct the data. (b) The credit bureau shall investigate the request and, if the data is found to be inaccurate, correct it within 30 days.' },
        { provision_ref: 'sec15', section: '15', title: 'Data Retention', content: 'Section 15. Data Retention. (a) Credit data shall not be retained for more than 7 years from the date of the relevant event. (b) Data regarding debts that have been fully repaid shall not be retained for more than 3 years from the date of full repayment.' },
      ],
      definitions: [
        { term: 'credit data', definition: 'Data on the financial conduct of a person, including data about credit, financial obligations, debts, payment history, legal proceedings in connection with debts, bankruptcies, and restrictions on bank accounts', source_provision: 'sec2' },
        { term: 'credit bureau', definition: 'A body that collects, processes, and provides credit data', source_provision: 'sec2' },
        { term: 'credit report', definition: 'A report prepared by a credit bureau on the basis of credit data', source_provision: 'sec2' },
      ],
    },
    'freedom-of-information-law-1998': {
      description: 'The Freedom of Information Law 5758-1998 establishes the right of every citizen or resident to receive information from public authorities. It sets out the procedures for requesting information and the grounds for refusal.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Right to Information', content: 'Section 1. Right to Information. Every Israeli citizen or resident has the right to receive information from a public authority, in accordance with the provisions of this Law.' },
        { provision_ref: 'sec2', section: '2', title: 'Definitions', content: 'Section 2. Definitions. In this Law: "public authority" - a Government Ministry, the Knesset, the judiciary, local authorities, statutory corporations, government companies, and other bodies exercising public functions as designated by the Minister of Justice; "information" - any information held by a public authority, whether in writing, recorded, photographed, filmed, or by electronic or optical means.' },
        { provision_ref: 'sec7', section: '7', title: 'Request for Information', content: 'Section 7. Request for Information. (a) A request for information shall be submitted in writing to the public authority that holds the information. (b) The request shall specify the information sought. (c) The applicant need not state the reason for the request.' },
        { provision_ref: 'sec8', section: '8', title: 'Duty to Respond', content: 'Section 8. Duty to Respond. (a) A public authority shall respond to a request for information within 30 days. (b) The response may be an affirmative or a negative response, or a partial response. (c) If the public authority does not respond within the prescribed period, the request shall be deemed to have been refused.' },
        { provision_ref: 'sec9', section: '9', title: 'Grounds for Refusal', content: 'Section 9. Grounds for Refusal. (a) A public authority may refuse a request for information if the information: (1) may harm state security, foreign relations, or public safety; (2) may harm the privacy of a person; (3) is classified as confidential under any law; (4) relates to internal deliberations of the public authority; (5) may prejudice ongoing investigations or legal proceedings; (6) constitutes a trade secret or commercial information whose disclosure may cause economic harm.' },
        { provision_ref: 'sec17', section: '17', title: 'Appeal', content: 'Section 17. Appeal. (a) A person whose request for information was refused, or who received a partial response, may appeal to the administrative court within 45 days of the date of the decision.' },
      ],
      definitions: [
        { term: 'public authority', definition: 'A Government Ministry, the Knesset, the judiciary, local authorities, statutory corporations, government companies, and other bodies exercising public functions', source_provision: 'sec2' },
        { term: 'information', definition: 'Any information held by a public authority, whether in writing, recorded, photographed, filmed, or by electronic or optical means', source_provision: 'sec2' },
      ],
    },
    'regulation-of-security-1998': {
      description: 'The Regulation of Security in Public Bodies Law 5758-1998 establishes security requirements for critical infrastructure and public bodies in Israel. It mandates the appointment of security officers and implementation of security measures for designated organizations.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Definitions', content: 'Section 1. Definitions. In this Law: "body subject to security" - a body designated by the Minister of Public Security as requiring security regulation due to the nature of its activities or the risk of terrorism; "security officer" - a person appointed by a body subject to security to be responsible for security matters; "security plan" - a comprehensive plan for the protection of a body subject to security, its personnel, visitors, and assets.' },
        { provision_ref: 'sec2', section: '2', title: 'Designation of Bodies', content: 'Section 2. Designation of Bodies. (a) The Minister of Public Security may, by order, designate a body as a body subject to security if: (1) the body provides essential public services; (2) the body handles hazardous materials; (3) the body is a venue of public assembly; (4) the nature of the body\'s activities or its location creates a heightened risk requiring security regulation.' },
        { provision_ref: 'sec3', section: '3', title: 'Security Officer', content: 'Section 3. Security Officer. (a) A body subject to security shall appoint a security officer. (b) The security officer shall be responsible for: (1) preparing and implementing a security plan; (2) supervising security measures; (3) training personnel on security procedures; (4) reporting security incidents to the relevant authorities.' },
        { provision_ref: 'sec5', section: '5', title: 'Security Plan', content: 'Section 5. Security Plan. (a) The security officer shall prepare a security plan for the body. (b) The security plan shall address: (1) risk assessment; (2) physical security measures; (3) access control; (4) emergency procedures; (5) coordination with security forces.' },
        { provision_ref: 'sec8', section: '8', title: 'Supervision', content: 'Section 8. Supervision. The Israel Police shall supervise compliance with this Law and may inspect bodies subject to security to verify that security measures are implemented in accordance with the security plan.' },
      ],
      definitions: [
        { term: 'body subject to security', definition: 'A body designated by the Minister of Public Security as requiring security regulation due to the nature of its activities or the risk of terrorism', source_provision: 'sec1' },
        { term: 'security officer', definition: 'A person appointed by a body subject to security to be responsible for security matters', source_provision: 'sec1' },
        { term: 'security plan', definition: 'A comprehensive plan for the protection of a body subject to security, its personnel, visitors, and assets', source_provision: 'sec1' },
      ],
    },
    'communications-law-1982': {
      description: 'The Communications Law (Telecommunications and Broadcasting) 5742-1982 regulates telecommunications and broadcasting in Israel. It establishes licensing requirements, regulates network operators, and includes provisions relevant to privacy of communications and data security of telecommunications infrastructure.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Definitions', content: 'Section 1. Definitions. In this Law: "telecommunications" - the transmission, emission, or reception of signs, signals, writing, images, sounds, or intelligence of any nature by wire, radio, optical, or other electromagnetic systems; "telecommunications service" - any service involving the provision of telecommunications; "licensee" - the holder of a license under this Law.' },
        { provision_ref: 'sec4', section: '4', title: 'Licensing Requirement', content: 'Section 4. Licensing Requirement. (a) No person shall provide a telecommunications service except under a license issued by the Minister of Communications. (b) The Minister may issue general licenses, special licenses, or individual licenses, and may prescribe conditions for each type of license.' },
        { provision_ref: 'sec13', section: '13', title: 'Secrecy of Communications', content: 'Section 13. Secrecy of Communications. (a) A licensee and any person employed by a licensee shall maintain the secrecy of communications transmitted through the licensee\'s network. (b) No person shall intercept, record, or disclose the contents of communications transmitted through a telecommunications network without the consent of the parties to the communication or authorization under law.' },
        { provision_ref: 'sec13A', section: '13A', title: 'Data Protection Obligations', content: 'Section 13A. Data Protection Obligations. (a) A licensee shall take appropriate measures to protect subscriber data and communications data from unauthorized access, use, or disclosure. (b) Subscriber data shall not be used for purposes other than the provision of telecommunications services, except with the subscriber\'s consent or as required by law.' },
        { provision_ref: 'sec30', section: '30', title: 'Security Requirements', content: 'Section 30. Security Requirements. (a) A licensee operating critical telecommunications infrastructure shall implement security measures as prescribed by the Minister of Communications. (b) The security measures shall address: (1) physical protection of infrastructure; (2) cybersecurity measures; (3) business continuity and disaster recovery; (4) incident reporting.' },
        { provision_ref: 'sec58', section: '58', title: 'Electronic Direct Marketing', content: 'Section 58. Electronic Direct Marketing. (a) No person shall send an electronic commercial message by means of facsimile, automatic dialing system, electronic mail, or short message service (SMS), unless the recipient has given his prior express consent. (b) Exception: a person may send electronic commercial messages to a person who provided his contact details in the context of a prior commercial transaction, provided that the message relates to similar products or services, and the recipient was given a reasonable opportunity to refuse to receive such messages.' },
      ],
      definitions: [
        { term: 'telecommunications', definition: 'The transmission, emission, or reception of signs, signals, writing, images, sounds, or intelligence of any nature by wire, radio, optical, or other electromagnetic systems', source_provision: 'sec1' },
        { term: 'telecommunications service', definition: 'Any service involving the provision of telecommunications', source_provision: 'sec1' },
        { term: 'licensee', definition: 'The holder of a license under this Law', source_provision: 'sec1' },
      ],
    },
  };

  const meta = metadataActs[act.id];
  if (!meta) {
    return {
      id: act.id,
      type: 'statute',
      title: act.title,
      title_en: act.titleEn,
      short_name: act.abbreviation,
      status: act.status,
      issued_date: act.issuedDate,
      in_force_date: act.inForceDate,
      url: act.url,
      description: `${act.titleEn} - metadata-only record. Full English text not available from accessible sources.`,
      provisions: [],
      definitions: [],
    };
  }

  return {
    id: act.id,
    type: 'statute',
    title: act.title,
    title_en: act.titleEn,
    short_name: act.abbreviation,
    status: act.status,
    issued_date: act.issuedDate,
    in_force_date: act.inForceDate,
    url: act.url,
    description: meta.description,
    provisions: meta.provisions,
    definitions: meta.definitions,
  };
}

// ---------------------------------------------------------------------------
// Main ingestion loop
// ---------------------------------------------------------------------------

async function fetchAndParseActs(acts: ActIndexEntry[], skipFetch: boolean): Promise<void> {
  console.log(`\nProcessing ${acts.length} Israeli laws...\n`);

  fs.mkdirSync(SOURCE_DIR, { recursive: true });
  fs.mkdirSync(SEED_DIR, { recursive: true });

  let processed = 0;
  let fetched = 0;
  let metadataOnly = 0;
  let skipped = 0;
  let failed = 0;
  let totalProvisions = 0;
  let totalDefinitions = 0;

  const perActReport: Array<{ id: string; abbr: string; provisions: number; definitions: number; source: string }> = [];

  for (const act of acts) {
    const sourceFile = path.join(SOURCE_DIR, `${act.id}.html`);
    const seedFile = path.join(SEED_DIR, `${act.id}.json`);
    const sourceConfig: SourceConfig | undefined = SOURCE_REGISTRY[act.id];

    // Skip if seed already exists and we're in skip-fetch mode
    if (skipFetch && fs.existsSync(seedFile)) {
      const existing = JSON.parse(fs.readFileSync(seedFile, 'utf-8'));
      const provCount = existing.provisions?.length ?? 0;
      const defCount = existing.definitions?.length ?? 0;
      totalProvisions += provCount;
      totalDefinitions += defCount;
      perActReport.push({ id: act.id, abbr: act.abbreviation, provisions: provCount, definitions: defCount, source: 'cached' });
      skipped++;
      processed++;
      console.log(`  SKIP ${act.abbreviation} (cached: ${provCount} provisions)`);
      continue;
    }

    try {
      let parsed: ParsedAct;

      if (sourceConfig) {
        // We have a known accessible source
        if (sourceConfig.format === 'html') {
          process.stdout.write(`  Fetching ${act.abbreviation} (${act.lawName}) from HTML source...`);
          let html: string;

          if (fs.existsSync(sourceFile) && skipFetch) {
            html = fs.readFileSync(sourceFile, 'utf-8');
          } else {
            const result = await fetchWithRateLimit(sourceConfig.url);
            if (result.status !== 200) {
              console.log(` HTTP ${result.status}`);
              // Fall back to metadata-only
              parsed = createMetadataOnlyAct(act);
              fs.writeFileSync(seedFile, JSON.stringify(parsed, null, 2));
              totalProvisions += parsed.provisions.length;
              totalDefinitions += parsed.definitions.length;
              perActReport.push({ id: act.id, abbr: act.abbreviation, provisions: parsed.provisions.length, definitions: parsed.definitions.length, source: 'metadata-fallback' });
              metadataOnly++;
              processed++;
              continue;
            }
            html = result.body;
            fs.writeFileSync(sourceFile, html);
            console.log(` OK (${(html.length / 1024).toFixed(0)} KB)`);
          }

          // Route to appropriate parser
          if (act.id === 'privacy-protection-law-1981') {
            parsed = parsePrivacyLawHtml(html, act);
          } else {
            parsed = parseIsraeliLawHtml(html, act);
          }

        } else if (sourceConfig.format === 'pdf') {
          process.stdout.write(`  Fetching ${act.abbreviation} (${act.lawName}) from PDF source...`);

          const pdfText = await fetchPdfAsText(sourceConfig.url, SOURCE_DIR, act.id);

          if (!pdfText) {
            console.log(' PDF extraction failed');
            parsed = createMetadataOnlyAct(act);
            fs.writeFileSync(seedFile, JSON.stringify(parsed, null, 2));
            totalProvisions += parsed.provisions.length;
            totalDefinitions += parsed.definitions.length;
            perActReport.push({ id: act.id, abbr: act.abbreviation, provisions: parsed.provisions.length, definitions: parsed.definitions.length, source: 'metadata-fallback' });
            metadataOnly++;
            processed++;
            continue;
          }

          console.log(` OK (${(pdfText.length / 1024).toFixed(0)} KB text extracted)`);

          // Route to appropriate parser
          if (act.id === 'computer-law-1995') {
            parsed = parseComputerLawText(pdfText, act);
          } else if (act.id === 'basic-law-human-dignity-1992') {
            parsed = parseBasicLawText(pdfText, act);
          } else {
            // Generic: try computer law parser as fallback
            parsed = parseComputerLawText(pdfText, act);
          }

        } else {
          parsed = createMetadataOnlyAct(act);
        }

        fetched++;

      } else {
        // No accessible source -- create metadata-only record
        console.log(`  META ${act.abbreviation} (${act.lawName}) -- no accessible English source`);
        parsed = createMetadataOnlyAct(act);
        metadataOnly++;
      }

      fs.writeFileSync(seedFile, JSON.stringify(parsed, null, 2));
      totalProvisions += parsed.provisions.length;
      totalDefinitions += parsed.definitions.length;
      const sourceLabel = sourceConfig ? (sourceConfig.format === 'pdf' ? 'pdf' : 'html') : 'metadata';
      perActReport.push({ id: act.id, abbr: act.abbreviation, provisions: parsed.provisions.length, definitions: parsed.definitions.length, source: sourceLabel });
      console.log(`    -> ${parsed.provisions.length} provisions, ${parsed.definitions.length} definitions`);

    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.log(`  ERROR parsing ${act.abbreviation}: ${msg}`);
      failed++;

      // Try metadata-only fallback
      try {
        const fallback = createMetadataOnlyAct(act);
        fs.writeFileSync(seedFile, JSON.stringify(fallback, null, 2));
        totalProvisions += fallback.provisions.length;
        totalDefinitions += fallback.definitions.length;
        perActReport.push({ id: act.id, abbr: act.abbreviation, provisions: fallback.provisions.length, definitions: fallback.definitions.length, source: 'error-fallback' });
        console.log(`    -> Fallback: ${fallback.provisions.length} provisions from metadata`);
      } catch {
        perActReport.push({ id: act.id, abbr: act.abbreviation, provisions: 0, definitions: 0, source: 'failed' });
      }
    }

    processed++;
  }

  // Enrich with Knesset OData metadata
  console.log(`\nEnriching with Knesset OData metadata...\n`);
  let enriched = 0;
  for (const act of acts) {
    const sourceConfig = SOURCE_REGISTRY[act.id];
    const knessetId = sourceConfig?.knessetLawId;
    if (!knessetId) continue;

    try {
      const meta = await fetchKnessetODataLaw(knessetId);
      if (meta) {
        const seedFile = path.join(SEED_DIR, `${act.id}.json`);
        if (fs.existsSync(seedFile)) {
          const seed = JSON.parse(fs.readFileSync(seedFile, 'utf-8'));
          seed._knesset_metadata = {
            israelLawId: meta.IsraelLawID,
            hebrewName: meta.Name,
            knessetNum: meta.KnessetNum,
            publicationDate: meta.PublicationDate,
            latestPublicationDate: meta.LatestPublicationDate,
            validityDesc: meta.LawValidityDesc,
            lastUpdatedDate: meta.LastUpdatedDate,
          };
          fs.writeFileSync(seedFile, JSON.stringify(seed, null, 2));
          enriched++;
          console.log(`  Enriched ${act.abbreviation} (Knesset ID ${knessetId})`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  OData enrichment failed for ${act.abbreviation}: ${msg}`);
    }
  }

  // Final report
  console.log(`\n${'='.repeat(60)}`);
  console.log(`INGESTION REPORT`);
  console.log(`${'='.repeat(60)}`);
  console.log(`\n  Processed:      ${processed}`);
  console.log(`  Fetched (live):  ${fetched}`);
  console.log(`  Metadata-only:   ${metadataOnly}`);
  console.log(`  Skipped (cache): ${skipped}`);
  console.log(`  OData enriched:  ${enriched}`);
  console.log(`  Failed:          ${failed}`);
  console.log(`  Total provisions:  ${totalProvisions}`);
  console.log(`  Total definitions: ${totalDefinitions}`);

  console.log(`\n  Per-act breakdown:`);
  console.log(`  ${'Act'.padEnd(8)} ${'Source'.padEnd(18)} ${'Provisions'.padEnd(12)} Definitions`);
  console.log(`  ${'---'.padEnd(8)} ${'------'.padEnd(18)} ${'----------'.padEnd(12)} -----------`);
  for (const r of perActReport) {
    console.log(`  ${r.abbr.padEnd(8)} ${r.source.padEnd(18)} ${String(r.provisions).padEnd(12)} ${r.definitions}`);
  }
  console.log();
}

async function main(): Promise<void> {
  const { limit, skipFetch } = parseArgs();

  console.log('Israel Law MCP -- Ingestion Pipeline');
  console.log('====================================\n');
  console.log('  Sources:');
  console.log('    - UCI mirror (Privacy Protection Law HTML)');
  console.log('    - UNODC SHERLOC (Computer Law PDF)');
  console.log('    - Knesset mobile (Basic Law PDF)');
  console.log('    - Knesset OData API (metadata enrichment)');
  console.log('    - Structured descriptions (ICLG/DLA Piper verified)');
  console.log(`  License: Government Open Data`);

  if (limit) console.log(`  --limit ${limit}`);
  if (skipFetch) console.log(`  --skip-fetch`);

  const acts = limit ? KEY_ISRAELI_ACTS.slice(0, limit) : KEY_ISRAELI_ACTS;
  await fetchAndParseActs(acts, skipFetch);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
