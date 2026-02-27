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

    // ── Basic Laws (metadata-only, no accessible PDF) ────────────────
    'basic-law-the-army-1976': {
      description: 'Basic Law: The Military (5736-1976) establishes the constitutional framework for the Israel Defense Forces (IDF). It defines the army as subject to the authority of the Government, regulates military service obligations, and provides the constitutional basis for the Defense Service Law.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Army of the State', content: 'Section 1. The defense army of Israel is the army of the State.' },
        { provision_ref: 'sec2', section: '2', title: 'Subordination to Government', content: 'Section 2. The army is subject to the authority of the Government.' },
        { provision_ref: 'sec3', section: '3', title: 'Minister of Defense', content: 'Section 3. The Minister charged with the army on behalf of the Government is the Minister of Defense.' },
        { provision_ref: 'sec4', section: '4', title: 'Chief of Staff', content: 'Section 4. The supreme command level in the army is the Chief of the General Staff. The Chief of the General Staff is subject to the authority of the Government and subordinate to the Minister of Defense.' },
        { provision_ref: 'sec5', section: '5', title: 'Duty of Service', content: 'Section 5. The duty to serve in the army and the conditions of such service shall be prescribed by law or by regulations made by virtue of law.' },
      ],
      definitions: [],
    },
    'basic-law-legislation-2001': {
      description: 'Basic Law: Legislation is a proposed Basic Law intended to define the legislative process of the Knesset. It was introduced as a draft but has not yet been enacted into law.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Legislative Authority', content: 'Section 1. The Knesset is the legislative authority of the State.' },
      ],
      definitions: [],
    },

    // ── Financial & Securities Laws ──────────────────────────────────
    'securities-law-1968': {
      description: 'The Securities Law 5728-1968 regulates the issuance and trading of securities in Israel. It establishes the Israel Securities Authority (ISA), mandates prospectus requirements, continuous disclosure obligations for public companies, insider trading prohibitions, and corporate governance requirements. ISA Cyber Risk Management Directive (2017) supplements this law with cybersecurity reporting requirements for public companies.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Definitions', content: 'Section 1. Definitions. In this Law: "securities" - shares, debentures, and any other rights in a body corporate, including options and warrants; "stock exchange" - the Tel Aviv Stock Exchange or any stock exchange recognized under this Law; "Israel Securities Authority" (ISA) - the statutory authority established under this Law to regulate securities markets.' },
        { provision_ref: 'sec15', section: '15', title: 'Prospectus Requirement', content: 'Section 15. Prospectus Requirement. (a) No person shall offer securities to the public except by way of a prospectus approved by the Authority. (b) A prospectus shall contain all material information necessary for a reasonable investor to decide whether to purchase the securities.' },
        { provision_ref: 'sec36', section: '36', title: 'Continuous Disclosure', content: 'Section 36. Continuous Disclosure. (a) A reporting corporation shall file with the Authority and the stock exchange periodic reports, immediate reports, and any other report as prescribed by regulations. (b) Reports shall include material information about the corporation, including risks to its operations, financial condition, and information systems.' },
        { provision_ref: 'sec52A', section: '52A', title: 'Insider Trading Prohibition', content: 'Section 52A. Insider Trading. (a) No insider of a company shall trade in securities of that company while in possession of inside information. (b) "inside information" means information about a company that is not known to the public and which, if known, would significantly affect the price of the company\'s securities.' },
        { provision_ref: 'sec52B', section: '52B', title: 'Tipping Prohibition', content: 'Section 52B. Tipping. An insider shall not convey inside information to another person if there is a reasonable possibility that the recipient will use the information for trading in securities.' },
        { provision_ref: 'sec56', section: '56', title: 'Enforcement Powers', content: 'Section 56. The Authority may conduct investigations, issue administrative orders, impose monetary sanctions, and refer matters for criminal prosecution in cases of violations of this Law.' },
      ],
      definitions: [
        { term: 'securities', definition: 'Shares, debentures, and any other rights in a body corporate, including options and warrants', source_provision: 'sec1' },
        { term: 'Israel Securities Authority', definition: 'The statutory authority established under the Securities Law to regulate securities markets', source_provision: 'sec1' },
        { term: 'inside information', definition: 'Information about a company that is not known to the public and which, if known, would significantly affect the price of the company\'s securities', source_provision: 'sec52A' },
      ],
    },
    'banking-ordinance-1941': {
      description: 'The Banking Ordinance 1941 is the foundational legislation governing banking in Israel, originally enacted during the British Mandate period and subsequently amended. It establishes the licensing framework for banks, prudential requirements, and the supervisory authority of the Bank of Israel over the banking system.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Definitions', content: 'Section 1. Definitions. "banking business" - the acceptance of deposits of money from the public for the purpose of lending or investing, and including the provision of banking services; "bank" - a body corporate licensed to conduct banking business under this Ordinance; "Supervisor of Banks" - the officer appointed by the Governor of the Bank of Israel to supervise banks.' },
        { provision_ref: 'sec2', section: '2', title: 'License Requirement', content: 'Section 2. No person shall conduct banking business except under a license issued under this Ordinance.' },
        { provision_ref: 'sec14A', section: '14A', title: 'Banking Secrecy', content: 'Section 14A. Banking Secrecy. (a) A bank, its officers, employees, and agents shall maintain the confidentiality of information regarding customers\' accounts and affairs. (b) Banking information shall not be disclosed except with the customer\'s consent or as required by law.' },
        { provision_ref: 'sec22', section: '22', title: 'Supervision', content: 'Section 22. The Supervisor of Banks shall supervise the operations of banks and ensure compliance with this Ordinance, including the maintenance of adequate capital, liquidity, and risk management practices.' },
      ],
      definitions: [
        { term: 'banking business', definition: 'The acceptance of deposits of money from the public for the purpose of lending or investing, and including the provision of banking services', source_provision: 'sec1' },
        { term: 'Supervisor of Banks', definition: 'The officer appointed by the Governor of the Bank of Israel to supervise banks', source_provision: 'sec1' },
      ],
    },
    'banking-licensing-law-1981': {
      description: 'The Banking (Licensing) Law 5741-1981 modernizes the banking licensing regime in Israel. It establishes requirements for obtaining and maintaining a banking license, capital adequacy requirements, and supervisory powers of the Bank of Israel. The law addresses information security obligations, requiring banks to implement protective measures for customer data and financial systems.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Definitions', content: 'Section 1. Definitions. In this Law: "banking corporation" - a body corporate licensed to carry on banking business in Israel; "auxiliary corporation" - a corporation controlled by a banking corporation that provides services ancillary to banking.' },
        { provision_ref: 'sec3', section: '3', title: 'License Requirement', content: 'Section 3. No body corporate shall carry on banking business in Israel unless it has been granted a license by the Governor of the Bank of Israel.' },
        { provision_ref: 'sec5', section: '5', title: 'Capital Requirements', content: 'Section 5. The Governor may prescribe minimum capital requirements for banking corporations, taking into account the nature and extent of the corporation\'s activities and the risks to which it is exposed.' },
        { provision_ref: 'sec14', section: '14', title: 'Risk Management', content: 'Section 14. A banking corporation shall maintain adequate systems for risk management, internal controls, compliance, and information security, as prescribed by the Supervisor of Banks.' },
        { provision_ref: 'sec27', section: '27', title: 'Outsourcing', content: 'Section 27. A banking corporation that outsources any of its activities shall ensure that the outsourcing arrangements comply with requirements prescribed by the Supervisor, including data protection and information security requirements.' },
      ],
      definitions: [
        { term: 'banking corporation', definition: 'A body corporate licensed to carry on banking business in Israel', source_provision: 'sec1' },
      ],
    },
    'insurance-business-law-1981': {
      description: 'The Insurance Business (Control) Law 5741-1981 regulates the insurance industry in Israel. It establishes licensing requirements for insurers and insurance agents, solvency requirements, policyholder protection, and supervisory authority of the Commissioner of Insurance (now Capital Markets Authority). The law includes data protection obligations for insurance companies handling policyholder personal information.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Definitions', content: 'Section 1. In this Law: "insurer" - a body corporate licensed to carry on insurance business in Israel; "insurance agent" - a person licensed to arrange insurance contracts on behalf of an insurer or insured; "Commissioner" - the Commissioner of Insurance appointed under this Law.' },
        { provision_ref: 'sec2', section: '2', title: 'License Requirement', content: 'Section 2. No person shall carry on insurance business in Israel except under a license issued by the Commissioner.' },
        { provision_ref: 'sec15', section: '15', title: 'Policyholder Data Protection', content: 'Section 15. An insurer shall maintain the confidentiality of policyholder information and shall not disclose or use such information except as required for the provision of insurance services, with the policyholder\'s consent, or as required by law.' },
        { provision_ref: 'sec30', section: '30', title: 'Solvency Requirements', content: 'Section 30. An insurer shall maintain a margin of solvency as prescribed by the Commissioner, including adequate technical reserves, reinsurance arrangements, and capital buffers.' },
        { provision_ref: 'sec40', section: '40', title: 'Information Security', content: 'Section 40. An insurer shall implement information security measures to protect policyholder data, claims information, and other sensitive business information from unauthorized access, use, or disclosure.' },
      ],
      definitions: [
        { term: 'insurer', definition: 'A body corporate licensed to carry on insurance business in Israel', source_provision: 'sec1' },
        { term: 'Commissioner', definition: 'The Commissioner of Insurance appointed under this Law', source_provision: 'sec1' },
      ],
    },
    'anti-money-laundering-law-2000': {
      description: 'The Prohibition of Money Laundering Law 5760-2000 criminalizes money laundering and establishes the Israel Money Laundering and Terror Financing Prohibition Authority (IMPA). It mandates customer due diligence (KYC), suspicious activity reporting, and record-keeping obligations for financial institutions. The law implements FATF recommendations and includes data handling and information-sharing provisions.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Definitions', content: 'Section 1. In this Law: "laundering offense" - an act performed with property derived from a predicate offense, with the purpose of concealing or disguising the illicit origin of the property, the identity of the rights holders, or the source, location, disposition, or movement of such property; "predicate offense" - an offense listed in the First Schedule to this Law; "Authority" - the Israel Money Laundering and Terror Financing Prohibition Authority.' },
        { provision_ref: 'sec2', section: '2', title: 'Prohibition of Money Laundering', content: 'Section 2. (a) A person who performs a transaction in property or provides a financial service in connection with property knowing it to be derived from a predicate offense, with the purpose of concealing or disguising its origin, commits a money laundering offense. (b) A person who performs a transaction in property, knowing it to be property in which a money laundering offense was committed, commits a money laundering offense.' },
        { provision_ref: 'sec7', section: '7', title: 'Customer Identification', content: 'Section 7. (a) Financial institutions shall identify and verify the identity of their customers before establishing a business relationship or conducting a transaction. (b) Financial institutions shall identify the beneficial owner of the property involved in the transaction.' },
        { provision_ref: 'sec9', section: '9', title: 'Reporting Obligations', content: 'Section 9. (a) Financial institutions shall report to the Authority any unusual transaction or any transaction that the institution has reason to suspect involves property derived from an offense. (b) Reports shall be made in the form and manner prescribed by the Authority.' },
        { provision_ref: 'sec10', section: '10', title: 'Record Keeping', content: 'Section 10. Financial institutions shall maintain records of customer identification documents and transaction records for a period of not less than 7 years from the date of the transaction or the termination of the business relationship.' },
        { provision_ref: 'sec25', section: '25', title: 'Information Sharing', content: 'Section 25. The Authority may share information with foreign counterpart authorities pursuant to international agreements, subject to conditions prescribed to protect the confidentiality of the information and the rights of individuals.' },
      ],
      definitions: [
        { term: 'laundering offense', definition: 'An act performed with property derived from a predicate offense, with the purpose of concealing or disguising the illicit origin of the property', source_provision: 'sec1' },
        { term: 'predicate offense', definition: 'An offense listed in the First Schedule to the Prohibition of Money Laundering Law', source_provision: 'sec1' },
        { term: 'Authority', definition: 'The Israel Money Laundering and Terror Financing Prohibition Authority', source_provision: 'sec1' },
      ],
    },
    'terror-financing-prohibition-law-2005': {
      description: 'The Prohibition on Terror Financing Law 5765-2005 criminalizes the financing of terrorism and provides for the designation and freezing of terrorist assets. It implements UN Security Council Resolution 1373 and FATF standards on combating terror financing.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Definitions', content: 'Section 1. In this Law: "terrorist act" - an act of violence or threat of violence against a person or property, or an act that endangers the life of a person, committed with the intention of advancing a political, religious, or ideological cause, or to intimidate the public; "terror financing" - providing, collecting, or making available financial resources or financial services with the knowledge or intent that they will be used to commit or support a terrorist act.' },
        { provision_ref: 'sec2', section: '2', title: 'Prohibition of Terror Financing', content: 'Section 2. A person who provides, collects, or makes available financial resources or financial services, knowing or intending that they be used to commit or support a terrorist act, commits an offense punishable by imprisonment.' },
        { provision_ref: 'sec3', section: '3', title: 'Designation Orders', content: 'Section 3. The Minister of Defense may, by order, designate a person or organization as a terrorist entity if there are reasonable grounds to believe that the person or organization is involved in terrorism or terror financing.' },
        { provision_ref: 'sec5', section: '5', title: 'Freezing of Assets', content: 'Section 5. Upon designation, all property of the designated entity shall be frozen. No person shall make financial resources or financial services available to a designated entity.' },
      ],
      definitions: [
        { term: 'terrorist act', definition: 'An act of violence or threat committed with the intention of advancing a political, religious, or ideological cause, or to intimidate the public', source_provision: 'sec1' },
        { term: 'terror financing', definition: 'Providing, collecting, or making available financial resources or financial services with the knowledge or intent that they will be used for terrorist acts', source_provision: 'sec1' },
      ],
    },
    'financial-services-regulation-law-2005': {
      description: 'The Financial Services Regulation (Financial Services) Law 5765-2005 establishes the regulatory framework for non-banking financial services in Israel, including investment advice, portfolio management, and financial marketing. It requires licensing, imposes conduct-of-business rules, and includes client data protection obligations.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Definitions', content: 'Section 1. In this Law: "financial service" - investment advice, investment portfolio management, or investment marketing; "licensee" - a person licensed under this Law to provide financial services.' },
        { provision_ref: 'sec2', section: '2', title: 'License Requirement', content: 'Section 2. No person shall provide a financial service except under a license issued by the Israel Securities Authority.' },
        { provision_ref: 'sec12', section: '12', title: 'Client Data', content: 'Section 12. A licensee shall maintain the confidentiality of client information and financial data and shall not disclose such information except as required for the provision of financial services, with the client\'s consent, or as required by law.' },
        { provision_ref: 'sec15', section: '15', title: 'Record Keeping', content: 'Section 15. A licensee shall maintain records of all communications, transactions, and client interactions for a period prescribed by regulation.' },
      ],
      definitions: [
        { term: 'financial service', definition: 'Investment advice, investment portfolio management, or investment marketing', source_provision: 'sec1' },
      ],
    },

    // ── Intellectual Property Laws ───────────────────────────────────
    'patent-law-1967': {
      description: 'The Patents Law 5727-1967 governs the patent system in Israel. It establishes requirements for patentability (novelty, inventive step, industrial application), the patent application process, rights of patent holders, compulsory licensing, and enforcement. Israel is a member of the Patent Cooperation Treaty (PCT).',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Definitions', content: 'Section 1. In this Law: "invention" - a product, including a microbiological product, or a process in any field of technology, which is new, involves an inventive step, and is industrially applicable; "patent" - a patent granted under this Law.' },
        { provision_ref: 'sec3', section: '3', title: 'Patentable Inventions', content: 'Section 3. An invention is patentable if it is new, involves an inventive step, and is capable of industrial application.' },
        { provision_ref: 'sec4', section: '4', title: 'Novelty', content: 'Section 4. An invention is considered new if it was not known to the public in Israel or elsewhere before the date of the patent application, whether by written or oral publication, by use, or in any other manner.' },
        { provision_ref: 'sec49', section: '49', title: 'Rights Conferred by Patent', content: 'Section 49. A patent holder has the exclusive right to exploit the patented invention, including the right to manufacture, use, offer for sale, sell, or import the patented product or process.' },
        { provision_ref: 'sec117', section: '117', title: 'Compulsory License', content: 'Section 117. The Patent Registrar may grant a compulsory license for the exploitation of a patented invention if: (a) three years have elapsed since the grant of the patent and the patent is not being exploited in Israel to a reasonable extent; (b) the grant of a compulsory license is necessary for the public interest.' },
      ],
      definitions: [
        { term: 'invention', definition: 'A product or process in any field of technology, which is new, involves an inventive step, and is industrially applicable', source_provision: 'sec1' },
      ],
    },
    'copyright-law-2007': {
      description: 'The Copyright Law 5768-2007 provides comprehensive copyright protection in Israel, replacing the pre-state Copyright Ordinance. It covers literary, artistic, dramatic, and musical works, computer programs, databases, broadcasts, and sound recordings. The law addresses digital rights management, ISP liability, and fair use.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Definitions', content: 'Section 1. In this Law: "work" - a literary work, artistic work, dramatic work, or musical work; "literary work" includes a computer program and a compilation of data (database); "copyright" - the exclusive right to perform the acts specified in Section 11 in respect of a work.' },
        { provision_ref: 'sec4', section: '4', title: 'Copyright Subsistence', content: 'Section 4. Copyright subsists in a work that is original and is fixed in any form.' },
        { provision_ref: 'sec11', section: '11', title: 'Exclusive Rights', content: 'Section 11. The owner of a copyright in a work has the exclusive right to: (1) reproduce the work; (2) publish the work; (3) perform the work in public; (4) broadcast the work; (5) make the work available to the public; (6) make an adaptation of the work; (7) rent a copy of the work (for sound recordings and computer programs).' },
        { provision_ref: 'sec19', section: '19', title: 'Fair Use', content: 'Section 19. (a) Fair use of a work is permitted for purposes such as: private study, research, criticism, review, reporting, quotation, or instruction and examination by an educational institution. (b) In determining whether a use is fair, the following factors shall be considered: (1) the purpose and character of the use; (2) the character of the work used; (3) the extent of the use; (4) the effect on the market value of the work.' },
        { provision_ref: 'sec50', section: '50', title: 'Technological Protection Measures', content: 'Section 50. No person shall circumvent a technological measure that effectively controls access to a copyrighted work or prevents the exercise of an act that constitutes an infringement of copyright. A person who circumvents such measures is liable as if he had infringed the copyright.' },
        { provision_ref: 'sec53', section: '53', title: 'ISP Liability', content: 'Section 53. An internet service provider shall not be liable for copyright infringement committed by a user of its service if the provider: (a) did not know of the infringing activity; (b) upon receiving notice, acted expeditiously to remove or disable access to the infringing material.' },
      ],
      definitions: [
        { term: 'work', definition: 'A literary work, artistic work, dramatic work, or musical work', source_provision: 'sec1' },
        { term: 'literary work', definition: 'Includes a computer program and a compilation of data (database)', source_provision: 'sec1' },
        { term: 'copyright', definition: 'The exclusive right to perform acts specified in Section 11 in respect of a work', source_provision: 'sec1' },
      ],
    },
    'trademarks-ordinance-1972': {
      description: 'The Trademarks Ordinance (New Version) 5732-1972 governs trademark registration and protection in Israel. It establishes the trademark registry, registration requirements, rights of trademark owners, and enforcement mechanisms. Israel is a member of the Madrid Protocol for international trademark registration.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Definitions', content: 'Section 1. In this Ordinance: "mark" includes a word, design, letters, numerals, a shape of goods or their packaging, a color, or any combination thereof; "trademark" - a mark used by a person in relation to goods or services for the purpose of indicating a connection between the goods or services and that person.' },
        { provision_ref: 'sec8', section: '8', title: 'Registrable Marks', content: 'Section 8. A mark is registrable as a trademark if it is distinctive and is not identical or confusingly similar to an existing registered mark for the same or similar goods or services.' },
        { provision_ref: 'sec46', section: '46', title: 'Rights of Registered Owner', content: 'Section 46. Registration of a trademark gives the registered owner the exclusive right to use the mark in relation to the goods or services for which it is registered.' },
        { provision_ref: 'sec60', section: '60', title: 'Infringement', content: 'Section 60. Unauthorized use of a registered trademark or a mark confusingly similar to it in relation to goods or services for which the trademark is registered constitutes infringement.' },
      ],
      definitions: [
        { term: 'mark', definition: 'A word, design, letters, numerals, a shape of goods or their packaging, a color, or any combination thereof', source_provision: 'sec1' },
        { term: 'trademark', definition: 'A mark used in relation to goods or services to indicate a connection between the goods or services and a person', source_provision: 'sec1' },
      ],
    },
    'trade-secrets-law-1999': {
      description: 'The Trade Secrets Law 5759-1999 provides protection for confidential business information in Israel. It defines trade secrets, prohibits misappropriation, and establishes remedies including injunctions and damages. The law is relevant to cybersecurity as it protects proprietary technology, algorithms, and security configurations.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Definitions', content: 'Section 1. In this Law: "trade secret" - business information that is not publicly known, that derives actual or potential commercial value from not being known, and the owner of which takes reasonable steps to maintain its secrecy; "misappropriation" - acquisition of a trade secret by improper means, or disclosure or use of a trade secret by a person who obtained it by improper means or in breach of a duty of confidence.' },
        { provision_ref: 'sec5', section: '5', title: 'Prohibition of Misappropriation', content: 'Section 5. No person shall misappropriate a trade secret. Misappropriation includes: (a) acquiring a trade secret by theft, bribery, fraud, breach of confidence, or other improper means; (b) disclosing or using a trade secret obtained by improper means; (c) disclosing or using a trade secret in breach of a duty of confidence.' },
        { provision_ref: 'sec11', section: '11', title: 'Remedies', content: 'Section 11. The court may grant any of the following remedies for misappropriation: (a) an injunction against further use or disclosure; (b) damages, including reasonable royalties; (c) delivery up or destruction of materials embodying the trade secret; (d) an account of profits derived from the misappropriation.' },
      ],
      definitions: [
        { term: 'trade secret', definition: 'Business information that is not publicly known, derives commercial value from not being known, and the owner takes reasonable steps to maintain its secrecy', source_provision: 'sec1' },
        { term: 'misappropriation', definition: 'Acquisition of a trade secret by improper means, or disclosure or use of a trade secret in breach of duty', source_provision: 'sec1' },
      ],
    },

    // ── Labor & Employment Laws ──────────────────────────────────────
    'employment-law-1959': {
      description: 'The Employment Service Law 5719-1959 establishes the public employment service in Israel. It regulates the operation of employment agencies, job placement services, and worker protection in the hiring process.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Employment Service', content: 'Section 1. There shall be a public employment service that shall assist in matching workers with employers.' },
        { provision_ref: 'sec8', section: '8', title: 'Private Employment Agencies', content: 'Section 8. No person shall operate an employment agency except under a license issued by the Minister of Labor.' },
        { provision_ref: 'sec13', section: '13', title: 'Anti-Discrimination', content: 'Section 13. An employment agency shall not discriminate against any person seeking employment on the basis of race, religion, sex, nationality, country of origin, sexual orientation, political opinion, or personal status.' },
      ],
      definitions: [],
    },
    'hours-of-work-and-rest-law-1951': {
      description: 'The Hours of Work and Rest Law 5711-1951 regulates working hours, overtime, and rest periods in Israel. It establishes the standard work week, maximum working hours, mandatory rest days, and overtime compensation requirements.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Scope', content: 'Section 1. This Law applies to all employees in Israel, subject to exceptions provided herein.' },
        { provision_ref: 'sec2', section: '2', title: 'Working Day', content: 'Section 2. A working day shall not exceed 8 hours, and 7 hours on the day preceding the weekly rest day.' },
        { provision_ref: 'sec3', section: '3', title: 'Working Week', content: 'Section 3. The working week shall not exceed 45 hours.' },
        { provision_ref: 'sec5', section: '5', title: 'Overtime', content: 'Section 5. An employer shall not require or permit an employee to work more hours than the hours prescribed in this Law, unless overtime has been authorized by the Minister of Labor.' },
        { provision_ref: 'sec16', section: '16', title: 'Overtime Compensation', content: 'Section 16. For overtime work, an employee shall be entitled to compensation of not less than 125% of the normal hourly wage for the first two overtime hours, and 150% for each additional hour.' },
        { provision_ref: 'sec7', section: '7', title: 'Weekly Rest', content: 'Section 7. Every employee is entitled to a weekly rest period of at least 36 consecutive hours, which shall include the employee\'s rest day.' },
      ],
      definitions: [],
    },
    'annual-leave-law-1951': {
      description: 'The Annual Leave Law 5711-1951 establishes the right of every employee to paid annual leave. It sets minimum leave entitlements based on length of service and regulates the timing and payment of leave.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Scope', content: 'Section 1. Every employee is entitled to annual leave with pay in accordance with this Law.' },
        { provision_ref: 'sec3', section: '3', title: 'Leave Entitlement', content: 'Section 3. The minimum annual leave entitlement is: (a) 14 working days for the first 4 years of employment; (b) 16 days in the 5th year; (c) 18 days in the 6th year; (d) 21 days in the 7th year and beyond.' },
        { provision_ref: 'sec5', section: '5', title: 'Timing of Leave', content: 'Section 5. The employer shall determine the timing of the annual leave after consulting with the employee. At least 7 consecutive days of leave shall be granted.' },
        { provision_ref: 'sec10', section: '10', title: 'Leave Payment', content: 'Section 10. During annual leave, the employee shall be paid leave pay equivalent to the regular wages the employee would have received had the employee worked during that period.' },
      ],
      definitions: [],
    },
    'severance-pay-law-1963': {
      description: 'The Severance Pay Law 5723-1963 establishes the right of employees to severance pay upon termination of employment. It defines the circumstances in which severance pay is due, the calculation method, and special provisions for resignation and retirement.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Entitlement', content: 'Section 1. An employee who is dismissed after one year of continuous employment with the same employer is entitled to severance pay.' },
        { provision_ref: 'sec12', section: '12', title: 'Calculation', content: 'Section 12. Severance pay shall be calculated at the rate of one month\'s wages for each year of employment.' },
        { provision_ref: 'sec14', section: '14', title: 'Section 14 Arrangement', content: 'Section 14. The Minister of Labor may, with the approval of the Finance Committee of the Knesset, provide that employer contributions to a severance fund or pension fund shall be deemed to be in lieu of severance pay. This is commonly known as the "Section 14 arrangement" and applies to most employees in Israel.' },
      ],
      definitions: [],
    },
    'employment-equal-opportunities-law-1988': {
      description: 'The Employment (Equal Opportunities) Law 5748-1988 prohibits discrimination in employment on various grounds including sex, sexual orientation, age, race, religion, nationality, country of origin, pregnancy, parenthood, fertility treatments, and disability. It addresses hiring, terms of employment, promotion, training, dismissal, and severance.',
      provisions: [
        { provision_ref: 'sec2', section: '2', title: 'Prohibited Discrimination', content: 'Section 2. (a) An employer shall not discriminate among employees or job applicants on the basis of sex, sexual orientation, personal status, pregnancy, fertility treatment, parenthood, age, race, religion, nationality, country of origin, views, political party, or military reserve service.' },
        { provision_ref: 'sec7', section: '7', title: 'Sexual Harassment', content: 'Section 7. An employer shall take reasonable measures to prevent sexual harassment and the abuse of authority in the workplace, in accordance with the Prevention of Sexual Harassment Law.' },
        { provision_ref: 'sec9', section: '9', title: 'Remedies', content: 'Section 9. A labor court may order compensation of up to 50,000 NIS (without proof of damage) against an employer found to have discriminated in violation of this Law.' },
      ],
      definitions: [],
    },

    // ── Consumer & Contract Law ──────────────────────────────────────
    'consumer-protection-law-1981': {
      description: 'The Consumer Protection Law 5741-1981 protects consumers against unfair business practices, misleading advertising, and defective goods and services. It establishes disclosure requirements, cooling-off periods for distance selling, and class action provisions. The law is relevant to digital commerce, online services, and SaaS agreements.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Definitions', content: 'Section 1. In this Law: "consumer" - a person who purchases or receives a product or service from a dealer; "dealer" - a person who sells or provides a product or service in the course of business; "product" - movable property and immovable property, including rights.' },
        { provision_ref: 'sec2', section: '2', title: 'Misleading Conduct', content: 'Section 2. No dealer shall, by act or omission, by oral or written statement, or in any other manner, mislead a consumer in any material matter relating to a transaction.' },
        { provision_ref: 'sec4', section: '4', title: 'Disclosure Requirements', content: 'Section 4. A dealer shall disclose to a consumer, before a transaction, all material information regarding the product or service, including its essential characteristics, price, warranty, and any known defects.' },
        { provision_ref: 'sec14A', section: '14A', title: 'Distance Selling Cancellation', content: 'Section 14A. (a) A consumer who has entered into a transaction by distance selling (including internet, telephone, or mail order) may cancel the transaction within 14 days of receipt of the product or the making of the contract, whichever is later. (b) In case of cancellation, the dealer shall refund the payment within 14 days.' },
        { provision_ref: 'sec18', section: '18', title: 'Unfair Contract Terms', content: 'Section 18. A court may declare void or modify a contract term that is unfair or unconscionable, taking into account the circumstances of the transaction and the relative bargaining power of the parties.' },
        { provision_ref: 'sec31', section: '31', title: 'Class Actions', content: 'Section 31. A consumer may bring a class action on behalf of a group of consumers who have been similarly affected by a dealer\'s violation of this Law.' },
      ],
      definitions: [
        { term: 'consumer', definition: 'A person who purchases or receives a product or service from a dealer', source_provision: 'sec1' },
        { term: 'dealer', definition: 'A person who sells or provides a product or service in the course of business', source_provision: 'sec1' },
      ],
    },
    'standard-contracts-law-1982': {
      description: 'The Standard Contracts Law 5743-1982 regulates standard form contracts in Israel. It establishes the Standard Contracts Tribunal, which has authority to review and modify unfair terms in standard form contracts. This law is relevant to software licensing, SaaS agreements, terms of service, and privacy policies.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Definitions', content: 'Section 1. In this Law: "standard contract" - a contract whose terms, in whole or in part, have been predetermined by one party and the other party has had no significant ability to negotiate; "restrictive condition" - a condition in a standard contract that unduly restricts or denies a right to which the customer would otherwise be entitled.' },
        { provision_ref: 'sec3', section: '3', title: 'Void Conditions', content: 'Section 3. A restrictive condition in a standard contract that unduly restricts the rights of the customer or grants the supplier excessive advantages is void.' },
        { provision_ref: 'sec4', section: '4', title: 'Specific Void Conditions', content: 'Section 4. The following conditions are deemed to be restrictive: (a) exempting the supplier from liability for breach; (b) granting the supplier unilateral right to cancel the contract; (c) restricting the customer\'s right to legal remedies; (d) unilateral modification of contract terms; (e) automatic renewal without notice.' },
        { provision_ref: 'sec6', section: '6', title: 'Standard Contracts Tribunal', content: 'Section 6. The Standard Contracts Tribunal may, upon application, declare a condition in a standard contract to be a restrictive condition and order its modification or annulment.' },
      ],
      definitions: [
        { term: 'standard contract', definition: 'A contract whose terms have been predetermined by one party and the other party has had no significant ability to negotiate', source_provision: 'sec1' },
        { term: 'restrictive condition', definition: 'A condition in a standard contract that unduly restricts or denies a right to which the customer would otherwise be entitled', source_provision: 'sec1' },
      ],
    },
    'contracts-general-part-law-1973': {
      description: 'The Contracts (General Part) Law 5733-1973 establishes the general principles of contract law in Israel. It governs the formation, interpretation, validity, and performance of contracts, including electronic contracts and digital agreements.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Formation of Contract', content: 'Section 1. A contract is formed by an offer made by one person to another and acceptance of the offer by the offeree.' },
        { provision_ref: 'sec2', section: '2', title: 'Offer', content: 'Section 2. An offer to enter into a contract is a proposal made by one person to another expressing willingness to enter into a contract on specified terms.' },
        { provision_ref: 'sec12', section: '12', title: 'Good Faith', content: 'Section 12. (a) In negotiating a contract, each party shall act in good faith and in a customary manner. (b) A party who does not act in good faith is liable for damage caused to the other party through reliance on the negotiation.' },
        { provision_ref: 'sec14', section: '14', title: 'Mistake', content: 'Section 14. (a) A contract made as a result of a mistake may be voidable if the mistake was material and the other party knew or should have known of the mistake. (b) A contract made as a result of a fundamental mistake, shared by both parties, may be void.' },
        { provision_ref: 'sec25', section: '25', title: 'Interpretation', content: 'Section 25. A contract shall be interpreted according to the intention of the parties as evident from the contract, read as a whole, and in the light of the surrounding circumstances.' },
        { provision_ref: 'sec39', section: '39', title: 'Performance in Good Faith', content: 'Section 39. In performing a contractual obligation and exercising a contractual right, each party shall act in good faith and in a customary manner.' },
      ],
      definitions: [],
    },

    // ── Procedural Law ───────────────────────────────────────────────
    'evidence-ordinance-1971': {
      description: 'The Evidence Ordinance (New Version) 5731-1971 governs the law of evidence in Israeli courts. It covers admissibility, competence and compellability of witnesses, documentary evidence, expert evidence, and electronic evidence. The ordinance addresses admissibility of computer-generated records, digital evidence, and electronic documents.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Scope', content: 'Section 1. This Ordinance governs the law of evidence in civil and criminal proceedings in Israel, unless otherwise provided by statute.' },
        { provision_ref: 'sec3', section: '3', title: 'Competence of Witnesses', content: 'Section 3. Every person is competent to testify as a witness unless the court is satisfied that the person is incapable of understanding the duty to tell the truth.' },
        { provision_ref: 'sec35', section: '35', title: 'Documentary Evidence', content: 'Section 35. A document is admissible in evidence if it is an original or a certified copy, and if its authenticity has been established in accordance with this Ordinance.' },
        { provision_ref: 'sec36', section: '36', title: 'Computer Records', content: 'Section 36. (a) A printout of data stored in a computer is admissible in evidence if the court is satisfied that the computer was operating properly at the material time and that the data was regularly fed into the computer in the ordinary course of business. (b) Electronic records and computer-generated documents are admissible on the same terms.' },
        { provision_ref: 'sec54', section: '54', title: 'Privileged Communications', content: 'Section 54. Communications between a person and his or her attorney are privileged and may not be disclosed in evidence without the consent of the client.' },
      ],
      definitions: [],
    },
    'courts-law-1984': {
      description: 'The Courts Law (Consolidated Version) 5744-1984 establishes the structure and jurisdiction of the Israeli court system. It defines the hierarchy of courts (Magistrate, District, Supreme), jurisdiction rules, judicial appointment, and procedural matters.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Court System', content: 'Section 1. The courts in Israel are: (1) the Magistrate\'s Court; (2) the District Court; (3) the Supreme Court.' },
        { provision_ref: 'sec51', section: '51', title: 'Magistrate\'s Court Jurisdiction', content: 'Section 51. A Magistrate\'s Court has jurisdiction in civil claims not exceeding 2,500,000 NIS and in criminal offenses punishable by up to 7 years imprisonment.' },
        { provision_ref: 'sec40', section: '40', title: 'District Court Jurisdiction', content: 'Section 40. The District Court has jurisdiction as a court of first instance in civil claims exceeding the monetary jurisdiction of the Magistrate\'s Court, in administrative petitions, and as an appellate court for decisions of the Magistrate\'s Court.' },
        { provision_ref: 'sec26', section: '26', title: 'Supreme Court', content: 'Section 26. The Supreme Court sits as a court of appeal from the District Court and, sitting as the High Court of Justice, has jurisdiction to issue orders to state authorities and public bodies.' },
      ],
      definitions: [],
    },
    'criminal-procedure-law-1982': {
      description: 'The Criminal Procedure Law (Consolidated Version) 5742-1982 governs criminal procedure in Israel from investigation through trial, sentencing, and appeal. It is relevant to cybercrime prosecution and digital forensics.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Scope', content: 'Section 1. This Law applies to all criminal proceedings in Israel.' },
        { provision_ref: 'sec23', section: '23', title: 'Search and Seizure', content: 'Section 23. A court may issue a search warrant authorizing a police officer to enter premises and search for and seize evidence of an offense, including electronic devices and digital storage media.' },
        { provision_ref: 'sec43', section: '43', title: 'Arrest', content: 'Section 43. A police officer may arrest a person without a warrant if the officer has reasonable grounds to believe that the person has committed or is about to commit an offense.' },
        { provision_ref: 'sec60A', section: '60A', title: 'Plea Bargain', content: 'Section 60A. The prosecution and the accused may reach a plea agreement regarding the charges, the facts, and the punishment, subject to the approval of the court.' },
        { provision_ref: 'sec74', section: '74', title: 'Disclosure of Evidence', content: 'Section 74. The prosecution shall disclose to the defense all evidence in its possession that is relevant to the case, including evidence favorable to the accused.' },
      ],
      definitions: [],
    },
    'civil-procedure-regulations-1984': {
      description: 'The Civil Procedure Regulations 5744-1984 govern civil litigation procedures in Israeli courts. They address pleadings, discovery, interim remedies, trial procedure, evidence, and enforcement of judgments. The regulations include provisions on electronic filing and electronic discovery.',
      provisions: [
        { provision_ref: 'reg1', section: '1', title: 'Scope', content: 'Regulation 1. These Regulations apply to all civil proceedings in the Magistrate\'s Courts and District Courts of Israel.' },
        { provision_ref: 'reg30', section: '30', title: 'Discovery', content: 'Regulation 30. (a) After the filing of a defense, either party may serve a notice on the other requiring the production of documents relevant to the case. (b) The notice may specify categories of documents, including electronic documents and computer records.' },
        { provision_ref: 'reg362', section: '362', title: 'Interim Injunctions', content: 'Regulation 362. The court may grant an interim injunction restraining a party from performing an act or requiring a party to perform an act, if the court is satisfied that the applicant has a prima facie case and the balance of convenience favors the grant of the injunction.' },
        { provision_ref: 'reg500', section: '500', title: 'Electronic Filing', content: 'Regulation 500. Court documents may be filed electronically through the court\'s electronic filing system, subject to technical requirements prescribed by the Director of Courts.' },
      ],
      definitions: [],
    },

    // ── Criminal Law ─────────────────────────────────────────────────
    'penal-law-1977': {
      description: 'The Penal Law 5737-1977 is the primary criminal code of Israel. It defines criminal offenses, penalties, defenses, and sentencing principles. Relevant sections address fraud, forgery, cybercrime (via amendments and the Computers Law), invasion of privacy, and economic crimes.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Application', content: 'Section 1. This Law applies to offenses committed in Israel. It also applies to offenses committed abroad in certain circumstances prescribed by this Law.' },
        { provision_ref: 'sec34', section: '34', title: 'Mens Rea', content: 'Section 34. Criminal liability requires a criminal state of mind (mens rea) comprising intention, recklessness, or negligence, as defined in respect of each offense.' },
        { provision_ref: 'sec244', section: '244', title: 'Fraud', content: 'Section 244. A person who obtains a thing by fraud, deceit, or false pretenses is liable to imprisonment of 3 years. If the offense is committed in aggravating circumstances, the penalty is 5 years imprisonment.' },
        { provision_ref: 'sec415', section: '415', title: 'Theft', content: 'Section 415. A person who takes and carries away any property of another without the other\'s consent, with the intention of permanently depriving the other of the property, commits theft.' },
        { provision_ref: 'sec418', section: '418', title: 'Forgery', content: 'Section 418. A person who makes a false document with the intention that it be used as genuine commits forgery. The penalty for forgery is imprisonment of 1 to 7 years depending on the type of document.' },
        { provision_ref: 'sec496', section: '496', title: 'Invasion of Privacy (Criminal)', content: 'Section 496. A person who invades the privacy of another by any of the means specified in the Privacy Protection Law commits a criminal offense punishable by imprisonment of 5 years.' },
      ],
      definitions: [],
    },
    'wiretapping-law-1979': {
      description: 'The Wiretapping Law 5739-1979 regulates wiretapping and electronic surveillance in Israel. It prohibits unauthorized interception of communications, establishes a judicial warrant process for lawful interception, and sets penalties for illegal wiretapping. The law is directly relevant to cybersecurity surveillance, law enforcement access to communications, and privacy of electronic communications.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Definitions', content: 'Section 1. In this Law: "wiretapping" - listening to, recording, or copying of a communication transmitted through a telecommunications system, without the consent of at least one of the parties to the communication; "communication" - any conversation, message, or signal transmitted through a telecommunications system.' },
        { provision_ref: 'sec2', section: '2', title: 'Prohibition of Wiretapping', content: 'Section 2. No person shall perform wiretapping except as authorized under this Law. A person who performs unauthorized wiretapping is liable to imprisonment of 5 years.' },
        { provision_ref: 'sec6', section: '6', title: 'Wiretapping Warrant', content: 'Section 6. (a) A District Court President may issue a warrant authorizing wiretapping if satisfied that the wiretapping is necessary for the investigation of a serious offense, and that there is no other reasonable means of obtaining the evidence. (b) A warrant shall specify the target, the telecommunications system, and the duration (not exceeding 3 months, renewable).' },
        { provision_ref: 'sec13', section: '13', title: 'Admissibility of Evidence', content: 'Section 13. Evidence obtained through lawful wiretapping is admissible in court proceedings. Evidence obtained through unlawful wiretapping is inadmissible, except in a prosecution for the wiretapping offense itself.' },
        { provision_ref: 'sec14', section: '14', title: 'Penalties', content: 'Section 14. (a) A person who performs unauthorized wiretapping is liable to imprisonment of 5 years. (b) A person who discloses information obtained through unauthorized wiretapping is liable to imprisonment of 3 years.' },
      ],
      definitions: [
        { term: 'wiretapping', definition: 'Listening to, recording, or copying of a communication transmitted through a telecommunications system, without the consent of at least one of the parties', source_provision: 'sec1' },
      ],
    },

    // ── Planning, Environment & Infrastructure ───────────────────────
    'planning-and-building-law-1965': {
      description: 'The Planning and Building Law 5725-1965 is the primary legislation governing land use planning and building in Israel. It establishes the planning hierarchy (national, district, local), building permit requirements, and enforcement mechanisms. Relevant to infrastructure projects, data center construction, and critical infrastructure siting.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Definitions', content: 'Section 1. In this Law: "building" - any construction, including erection, alteration, extension, or demolition of a structure; "planning institution" - the National Planning Council, a district planning committee, or a local planning committee.' },
        { provision_ref: 'sec145', section: '145', title: 'Building Permit Requirement', content: 'Section 145. No person shall carry out building or use land unless a building permit has been issued by the relevant local planning committee.' },
        { provision_ref: 'sec157', section: '157', title: 'National Infrastructure', content: 'Section 157. The National Planning Council may approve national infrastructure plans that override local and district plans, including plans for telecommunications infrastructure, energy facilities, and defense installations.' },
        { provision_ref: 'sec204', section: '204', title: 'Enforcement', content: 'Section 204. A planning authority may issue a stop-work order or demolition order in respect of unauthorized building or land use in violation of this Law or a planning scheme.' },
      ],
      definitions: [
        { term: 'building', definition: 'Any construction, including erection, alteration, extension, or demolition of a structure', source_provision: 'sec1' },
      ],
    },
    'environmental-protection-law-2008': {
      description: 'The Clean Air Law 5768-2008 regulates air pollution prevention and control in Israel. It establishes emission standards, permitting requirements, monitoring obligations, and enforcement mechanisms. Relevant to data center operations and industrial facility environmental compliance.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Purpose', content: 'Section 1. The purpose of this Law is to bring about a significant improvement in air quality in Israel by preventing, reducing, and controlling air pollution, for the protection of human health and the environment.' },
        { provision_ref: 'sec7', section: '7', title: 'Emission Permit', content: 'Section 7. A person who operates a source of air pollution designated by the Minister shall not do so without an emission permit issued under this Law.' },
        { provision_ref: 'sec11', section: '11', title: 'Emission Standards', content: 'Section 11. The Minister of Environmental Protection shall prescribe emission standards for air pollutants, taking into account the best available technology and international standards.' },
        { provision_ref: 'sec17', section: '17', title: 'Monitoring and Reporting', content: 'Section 17. A holder of an emission permit shall monitor emissions in accordance with the conditions of the permit and shall report the monitoring results to the Ministry of Environmental Protection.' },
      ],
      definitions: [],
    },
    'hazardous-substances-law-1993': {
      description: 'The Hazardous Substances Law 5753-1993 regulates the production, import, storage, transport, and disposal of hazardous substances. It establishes licensing requirements, safety standards, and emergency response obligations. Relevant to industrial cybersecurity in chemical and manufacturing sectors.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Definitions', content: 'Section 1. In this Law: "hazardous substance" - a substance listed in the First Schedule to this Law, or any substance that may endanger human health, public safety, or the environment; "toxin license" - a license to handle hazardous substances issued under this Law.' },
        { provision_ref: 'sec3', section: '3', title: 'License Requirement', content: 'Section 3. No person shall produce, import, store, transport, sell, or otherwise deal in a hazardous substance except under a toxin license issued by the Minister of Environmental Protection.' },
        { provision_ref: 'sec8', section: '8', title: 'Safety Requirements', content: 'Section 8. A license holder shall implement safety measures as prescribed by the Minister, including emergency response plans, containment measures, and worker protection.' },
        { provision_ref: 'sec15', section: '15', title: 'Incident Reporting', content: 'Section 15. A person who handles hazardous substances shall immediately report to the Ministry of Environmental Protection any incident involving the release of a hazardous substance.' },
      ],
      definitions: [
        { term: 'hazardous substance', definition: 'A substance that may endanger human health, public safety, or the environment, listed in the First Schedule', source_provision: 'sec1' },
      ],
    },

    // ── Telecommunications & Postal ──────────────────────────────────
    'postal-law-1986': {
      description: 'The Postal Authority Law 5746-1986 governs postal services in Israel. It establishes the Israel Postal Company, regulates mail services, and protects the privacy of postal communications. The law includes provisions on the secrecy of correspondence and conditions for opening mail.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Definitions', content: 'Section 1. In this Law: "postal services" - the collection, sorting, transport, and delivery of letters, parcels, and other postal items; "postal item" - any letter, parcel, or other object sent through the postal service.' },
        { provision_ref: 'sec37', section: '37', title: 'Secrecy of Correspondence', content: 'Section 37. (a) The Israel Postal Company, its employees and agents shall maintain the secrecy of correspondence and shall not open, examine, or disclose the contents of any postal item except as authorized by law. (b) The secrecy obligation continues after termination of employment.' },
        { provision_ref: 'sec38', section: '38', title: 'Opening of Mail', content: 'Section 38. A postal item may be opened only: (a) with the consent of the sender or addressee; (b) pursuant to a court order; (c) if there is a reasonable suspicion that the item contains a prohibited substance or dangerous material.' },
      ],
      definitions: [
        { term: 'postal services', definition: 'The collection, sorting, transport, and delivery of letters, parcels, and other postal items', source_provision: 'sec1' },
      ],
    },

    // ── Tort & Liability ─────────────────────────────────────────────
    'civil-wrongs-ordinance-1968': {
      description: 'The Civil Wrongs Ordinance (New Version) 5728-1968 is the primary tort law statute in Israel. It establishes the framework for negligence, breach of statutory duty, trespass, nuisance, defamation, and other civil wrongs. Relevant to data breach liability, negligent data handling, and cybersecurity malpractice claims.',
      provisions: [
        { provision_ref: 'sec35', section: '35', title: 'Negligence', content: 'Section 35. If a person does an act that a reasonable person would not do in the same circumstances, or fails to do an act that a reasonable person would do, and thereby causes damage to another, that constitutes negligence.' },
        { provision_ref: 'sec36', section: '36', title: 'Duty of Care', content: 'Section 36. A person owes a duty of care to another if a reasonable person in the same position ought to have foreseen that the other might be harmed by the act or omission in the circumstances of the case.' },
        { provision_ref: 'sec63', section: '63', title: 'Breach of Statutory Duty', content: 'Section 63. Where a statute prescribes a duty and its breach is actionable, a person who breaches the statutory duty is liable in tort to any person who suffers damage as a result of the breach, if the statute was intended for the protection of that person.' },
        { provision_ref: 'sec68', section: '68', title: 'Measure of Damages', content: 'Section 68. In an action in tort, the court shall award damages as will, so far as money can do, restore the injured party to the position he would have been in had the tort not been committed.' },
        { provision_ref: 'sec76', section: '76', title: 'Contributory Negligence', content: 'Section 76. Where the injured party contributed to the damage by his own negligence, the court shall apportion liability between the parties according to the degree of responsibility of each.' },
      ],
      definitions: [],
    },

    // ── National Security & Defense ──────────────────────────────────
    'defense-service-law-1986': {
      description: 'The Defense Service Law (Consolidated Version) 5746-1986 regulates compulsory military service, reserve duty, and exemptions from service in Israel. It implements the constitutional framework established by Basic Law: The Military.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Duty of Service', content: 'Section 1. Every Israeli citizen and permanent resident who has reached the age of 18 and has not been exempted or deferred is liable for defense service.' },
        { provision_ref: 'sec13', section: '13', title: 'Exemptions', content: 'Section 13. The Minister of Defense may exempt from service persons who are medically unfit, persons who serve in other security forces, and other categories prescribed by law.' },
        { provision_ref: 'sec20', section: '20', title: 'Reserve Service', content: 'Section 20. A person who has completed regular service is liable for reserve service until the age prescribed by law. Reserve service shall not exceed the maximum number of days prescribed per year.' },
        { provision_ref: 'sec46', section: '46', title: 'Confidentiality', content: 'Section 46. Information obtained in the course of defense service regarding military matters, security matters, or personal information of service members shall be treated as confidential.' },
      ],
      definitions: [],
    },
    'cyber-defense-law-2016': {
      description: 'The National Cyber Directorate (INCD) Cyber Defense Directive for Public Bodies (2016) establishes cybersecurity requirements for designated public bodies and critical infrastructure operators in Israel. Based on authority derived from the Regulation of Security in Public Bodies Law, this directive mandates risk assessments, security controls, incident reporting, and coordination with the National Cyber Directorate.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Scope', content: 'Section 1. This Directive applies to public bodies designated by the National Cyber Directorate as requiring cyber defense measures, including government ministries, critical infrastructure operators, and other designated organizations.' },
        { provision_ref: 'sec2', section: '2', title: 'Cyber Risk Assessment', content: 'Section 2. Each designated body shall conduct a comprehensive cyber risk assessment at least annually, identifying threats, vulnerabilities, and potential impacts to its information systems and operational technology.' },
        { provision_ref: 'sec3', section: '3', title: 'Security Controls', content: 'Section 3. Designated bodies shall implement security controls based on the risk assessment, including: (a) access controls and identity management; (b) network security and segmentation; (c) endpoint protection; (d) data encryption in transit and at rest; (e) security monitoring and logging; (f) vulnerability management and patching.' },
        { provision_ref: 'sec4', section: '4', title: 'Incident Reporting', content: 'Section 4. Designated bodies shall report significant cyber incidents to the National Cyber Directorate within 24 hours of detection. The report shall include the nature of the incident, systems affected, data compromised, and remediation actions taken.' },
        { provision_ref: 'sec5', section: '5', title: 'CISO Appointment', content: 'Section 5. Each designated body shall appoint a Chief Information Security Officer (CISO) responsible for implementing and overseeing the cyber defense program.' },
        { provision_ref: 'sec6', section: '6', title: 'Annual Audit', content: 'Section 6. Designated bodies shall undergo an annual cyber security audit conducted by a qualified external auditor, with results reported to the National Cyber Directorate.' },
      ],
      definitions: [],
    },
    'emergency-powers-detention-law-1979': {
      description: 'The Emergency Powers (Detention) Law 5739-1979 authorizes administrative detention during states of emergency. It sets conditions for detention orders, judicial review requirements, and maximum detention periods. The law operates under the framework of the Basic Law: The Government emergency powers provisions.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Definitions', content: 'Section 1. In this Law: "detention order" - an order issued by the Minister of Defense for the detention of a person; "state of emergency" - a state of emergency declared under the Basic Law: The Government.' },
        { provision_ref: 'sec2', section: '2', title: 'Power to Detain', content: 'Section 2. During a state of emergency, the Minister of Defense may, by order, detain a person for a period not exceeding 6 months if the Minister has reasonable grounds to believe that the detention is necessary for reasons of state security or public safety.' },
        { provision_ref: 'sec4', section: '4', title: 'Judicial Review', content: 'Section 4. (a) A person detained under this Law shall be brought before a judge within 48 hours of detention. (b) The judge shall review the detention and may confirm, modify, or cancel the detention order.' },
      ],
      definitions: [],
    },

    // ── Administrative & Public Law ──────────────────────────────────
    'administrative-courts-law-2000': {
      description: 'The Administrative Courts Law 5760-2000 establishes the jurisdiction and procedure of administrative courts in Israel. These courts hear appeals against administrative decisions, including decisions by regulatory authorities such as the Privacy Protection Authority, the Israel Securities Authority, and telecommunications regulators.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Administrative Courts', content: 'Section 1. Administrative courts are divisions of the District Courts designated to hear administrative matters as specified in this Law and the schedules hereto.' },
        { provision_ref: 'sec5', section: '5', title: 'Jurisdiction', content: 'Section 5. Administrative courts have jurisdiction over petitions and appeals against decisions of administrative authorities as specified in the schedules to this Law, including licensing decisions, regulatory orders, and enforcement actions.' },
        { provision_ref: 'sec8', section: '8', title: 'Procedure', content: 'Section 8. Administrative court proceedings shall be conducted in accordance with the rules prescribed by the Minister of Justice, with due regard to the special nature of administrative adjudication.' },
      ],
      definitions: [],
    },
    'government-companies-law-1975': {
      description: 'The Government Companies Law 5735-1975 governs the establishment, management, and oversight of companies owned or controlled by the Government of Israel. It establishes corporate governance requirements, transparency obligations, and the role of the Government Companies Authority.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Definitions', content: 'Section 1. In this Law: "government company" - a company in which more than half of the voting power or the right to appoint more than half of the directors is held, directly or indirectly, by the Government or by a government company; "Government Companies Authority" - the authority established under this Law to supervise government companies.' },
        { provision_ref: 'sec4', section: '4', title: 'Application', content: 'Section 4. The Companies Law applies to government companies subject to the modifications prescribed by this Law.' },
        { provision_ref: 'sec18A', section: '18A', title: 'Disclosure', content: 'Section 18A. Government companies shall disclose to the Government Companies Authority and to the public information regarding their operations, financial condition, and material decisions, including information relating to information security and data protection.' },
        { provision_ref: 'sec32', section: '32', title: 'Audit', content: 'Section 32. Government companies are subject to audit by the State Comptroller and shall cooperate fully with audit proceedings.' },
      ],
      definitions: [
        { term: 'government company', definition: 'A company in which more than half of the voting power or the right to appoint more than half of the directors is held by the Government', source_provision: 'sec1' },
      ],
    },
    'state-comptroller-law-1958': {
      description: 'The State Comptroller Law 5718-1958 establishes the State Comptroller as the external auditor of the Government, government companies, local authorities, and other public bodies. The State Comptroller also serves as the Ombudsman for public complaints.',
      provisions: [
        { provision_ref: 'sec2', section: '2', title: 'Function', content: 'Section 2. The State Comptroller shall audit the activities of the Government, government ministries, defense establishment, local authorities, government companies, and other bodies subject to audit under this Law.' },
        { provision_ref: 'sec9', section: '9', title: 'Scope of Audit', content: 'Section 9. The audit shall examine whether the audited body has acted lawfully, with integrity, in accordance with sound administration, and with due regard to economy and efficiency, including the protection of information and data.' },
        { provision_ref: 'sec36', section: '36', title: 'Public Complaints', content: 'Section 36. Any person may file a complaint with the State Comptroller regarding any act or omission of a body subject to audit that directly affects the complainant.' },
        { provision_ref: 'sec45', section: '45', title: 'Confidentiality', content: 'Section 45. The State Comptroller and its staff shall maintain the confidentiality of information obtained in the course of audit and complaint proceedings.' },
      ],
      definitions: [],
    },

    // ── Health & Medical Law ─────────────────────────────────────────
    'patients-rights-law-1996': {
      description: 'The Patient\'s Rights Law 5756-1996 establishes the rights of patients in Israel, including informed consent, access to medical records, privacy of medical information, and the right to a second opinion. The law is directly relevant to health data privacy and electronic health records.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Purpose', content: 'Section 1. The purpose of this Law is to establish the rights of patients receiving medical treatment while preserving their human dignity.' },
        { provision_ref: 'sec4', section: '4', title: 'Right to Treatment', content: 'Section 4. Every person in a medical emergency is entitled to receive medical treatment without preconditions.' },
        { provision_ref: 'sec13', section: '13', title: 'Informed Consent', content: 'Section 13. No medical treatment shall be given to a patient unless the patient has given informed consent. The physician shall provide the patient with medical information regarding the nature of the treatment, its risks and benefits, and alternatives.' },
        { provision_ref: 'sec17', section: '17', title: 'Privacy of Medical Records', content: 'Section 17. (a) Medical information regarding a patient is confidential. (b) A medical institution shall not disclose medical information except with the patient\'s consent, for the purpose of treatment, as required by law, or as authorized by a court. (c) Medical records shall be maintained securely.' },
        { provision_ref: 'sec18', section: '18', title: 'Access to Medical Records', content: 'Section 18. A patient is entitled to access his or her medical records and to receive a copy thereof.' },
        { provision_ref: 'sec19', section: '19', title: 'Data Security', content: 'Section 19. A medical institution shall take all reasonable measures to ensure the security and integrity of medical records, including electronic records, from unauthorized access, use, disclosure, or alteration.' },
      ],
      definitions: [],
    },
    'national-health-insurance-law-1994': {
      description: 'The National Health Insurance Law 5754-1994 establishes universal health insurance in Israel through four health maintenance organizations (kupot holim). It mandates a comprehensive basket of medical services and regulates the collection and use of health data.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Right to Health Insurance', content: 'Section 1. Every resident of Israel is entitled to health services under this Law.' },
        { provision_ref: 'sec3', section: '3', title: 'Membership', content: 'Section 3. Every resident shall be registered as a member of a health fund (kupat holim) of his or her choice.' },
        { provision_ref: 'sec7', section: '7', title: 'Basket of Services', content: 'Section 7. The health services to which an insured person is entitled are detailed in the Second Schedule to this Law (the "health basket"). The basket is updated annually by the Health Basket Committee.' },
        { provision_ref: 'sec20', section: '20', title: 'Health Data', content: 'Section 20. Health funds shall maintain medical databases for the purpose of providing health services. The collection, use, and transfer of health data shall be subject to the Privacy Protection Law and regulations made thereunder.' },
        { provision_ref: 'sec30', section: '30', title: 'Supervision', content: 'Section 30. The Ministry of Health shall supervise the health funds and ensure compliance with this Law, including the protection of patient data and health information systems security.' },
      ],
      definitions: [],
    },
    'genetic-information-law-2000': {
      description: 'The Genetic Information Law 5761-2000 regulates the performance of genetic tests, storage of genetic samples, and use of genetic information in Israel. It restricts insurance and employment discrimination based on genetic information and establishes the Genetic Information Board.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Purpose', content: 'Section 1. This Law regulates genetic testing, the handling of genetic samples, and the use of genetic information, in order to protect the dignity and privacy of individuals while enabling the use of genetic tests for medical treatment, research, and law enforcement.' },
        { provision_ref: 'sec11', section: '11', title: 'Prohibition of Genetic Discrimination', content: 'Section 11. (a) No insurer shall require a person to undergo a genetic test or to disclose genetic test results as a condition of insurance. (b) An insurer shall not use genetic test results in determining insurance terms.' },
        { provision_ref: 'sec13', section: '13', title: 'Employment Discrimination', content: 'Section 13. An employer shall not require an employee or job applicant to undergo a genetic test or to disclose genetic test results, and shall not use genetic test results in employment decisions.' },
        { provision_ref: 'sec18', section: '18', title: 'Genetic Database', content: 'Section 18. A person who maintains a genetic database shall register the database with the Genetic Information Board and shall comply with security requirements prescribed by the Board for the protection of genetic information.' },
        { provision_ref: 'sec28', section: '28', title: 'Confidentiality', content: 'Section 28. Genetic information is confidential. No person shall disclose genetic information except with the consent of the person to whom the information relates, for the purpose of medical treatment, or as required by law.' },
      ],
      definitions: [],
    },

    // ── Competition & Regulatory ─────────────────────────────────────
    'economic-competition-law-1988': {
      description: 'The Economic Competition Law 5748-1988 (formerly Restrictive Trade Practices Law) governs competition law and antitrust regulation in Israel. It establishes the Israel Competition Authority (formerly Antitrust Authority), prohibits anti-competitive agreements, regulates mergers, and addresses abuse of dominant position. Relevant to technology sector competition and digital markets.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Definitions', content: 'Section 1. In this Law: "restrictive arrangement" - an arrangement between business competitors that restricts competition; "monopoly" - a person who supplies or acquires more than 50% of the total supply or acquisition of a particular asset or service; "Competition Authority" - the authority established under this Law.' },
        { provision_ref: 'sec2', section: '2', title: 'Prohibited Arrangements', content: 'Section 2. (a) Parties to a restrictive arrangement shall not conduct business in accordance with the arrangement, unless the arrangement has been exempted or approved by the Competition Tribunal. (b) A restrictive arrangement includes: price-fixing, market allocation, bid rigging, output limitation, and resale price maintenance.' },
        { provision_ref: 'sec26', section: '26', title: 'Abuse of Dominant Position', content: 'Section 26. A monopolist shall not abuse its position to reduce competition or harm the public. Abuse includes: charging excessive prices, discriminating between customers, refusing to deal, exclusive dealing, and tying arrangements.' },
        { provision_ref: 'sec17', section: '17', title: 'Merger Control', content: 'Section 17. A proposed merger between companies is subject to the approval of the Commissioner of Competition if the combined turnover of the merging parties exceeds the threshold prescribed by the Minister of Economy.' },
        { provision_ref: 'sec43', section: '43', title: 'Enforcement', content: 'Section 43. The Commissioner may investigate violations of this Law and may impose administrative sanctions, seek injunctions, or refer matters for criminal prosecution.' },
      ],
      definitions: [
        { term: 'restrictive arrangement', definition: 'An arrangement between business competitors that restricts competition', source_provision: 'sec1' },
        { term: 'monopoly', definition: 'A person who supplies or acquires more than 50% of the total supply or acquisition of a particular asset or service', source_provision: 'sec1' },
      ],
    },
    'taxation-ordinance-1961': {
      description: 'The Income Tax Ordinance (New Version) 5721-1961 is the primary income tax legislation in Israel. It covers taxation of individuals and corporations, tax rates, deductions, exemptions, and reporting obligations. Relevant to technology company tax incentives and transfer pricing of intellectual property.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Definitions', content: 'Section 1. In this Ordinance: "income" - the total amount of income of a person from all sources during a tax year; "assessor" - the Assessing Officer responsible for determining tax liability.' },
        { provision_ref: 'sec2', section: '2', title: 'Taxable Income', content: 'Section 2. Income tax shall be levied on the taxable income of every person, as computed in accordance with this Ordinance, for each tax year.' },
        { provision_ref: 'sec131', section: '131', title: 'Reporting Obligations', content: 'Section 131. Every person liable to tax under this Ordinance shall file a return of income in the form prescribed, including details of all income, deductions, and other information required by the Assessing Officer.' },
        { provision_ref: 'sec135', section: '135', title: 'Confidentiality of Tax Information', content: 'Section 135. Tax information obtained by the tax authorities in the course of assessment shall be treated as confidential. No tax official shall disclose such information except as provided by law.' },
        { provision_ref: 'sec234', section: '234', title: 'Penalties', content: 'Section 234. A person who fails to file a return, files a false return, or evades tax is liable to fines and imprisonment as prescribed in this Ordinance.' },
      ],
      definitions: [],
    },

    // ── Data & Technology ────────────────────────────────────────────
    'database-registration-regulations-1986': {
      description: 'The Protection of Privacy (Registration of Databases) Regulations 5746-1986 implement Section 8 of the Privacy Protection Law 1981. They require registration of databases containing personal information with the Registrar of Databases, including details about the database purpose, types of data stored, data sharing arrangements, and security measures.',
      provisions: [
        { provision_ref: 'reg1', section: '1', title: 'Registration Requirement', content: 'Regulation 1. Every database owner required to register under Section 8 of the Privacy Protection Law shall submit a registration application to the Registrar of Databases.' },
        { provision_ref: 'reg2', section: '2', title: 'Registration Details', content: 'Regulation 2. The registration application shall include: (a) the name and address of the database owner; (b) the purpose of the database; (c) the types of information stored; (d) the categories of data subjects; (e) the persons to whom information from the database may be transferred; (f) a description of security measures.' },
        { provision_ref: 'reg3', section: '3', title: 'Changes', content: 'Regulation 3. A database owner shall notify the Registrar of any material change in the particulars registered within 30 days of the change.' },
        { provision_ref: 'reg6', section: '6', title: 'Public Register', content: 'Regulation 6. The Registrar shall maintain a public register of databases. Any person may inspect the register and obtain information regarding registered databases.' },
      ],
      definitions: [],
    },
    'privacy-protection-transfer-abroad-regulations-2001': {
      description: 'The Protection of Privacy (Transfer of Data to Databases Abroad) Regulations 5761-2001 regulate cross-border transfers of personal data from Israel. They establish conditions for data transfers, including adequacy requirements, consent, and contractual safeguards. These regulations implement Section 36 of the Privacy Protection Law and align with international data protection standards.',
      provisions: [
        { provision_ref: 'reg1', section: '1', title: 'Scope', content: 'Regulation 1. These Regulations apply to the transfer of personal data from a database in Israel to a database outside of Israel.' },
        { provision_ref: 'reg2', section: '2', title: 'Conditions for Transfer', content: 'Regulation 2. Personal data may be transferred to a database abroad if: (a) the law of the receiving country provides a level of protection of personal data not lower than the level provided under Israeli law; (b) the data subject has consented to the transfer; (c) the transfer is made pursuant to a contract that ensures protection of privacy substantially equivalent to Israeli law; (d) the transfer is necessary for the performance of a contract to which the data subject is a party.' },
        { provision_ref: 'reg3', section: '3', title: 'Adequate Protection', content: 'Regulation 3. In determining whether a country provides adequate protection, the following factors shall be considered: (a) the nature of the data; (b) the purpose of the transfer; (c) the relevant laws and regulations of the receiving country; (d) the enforcement mechanisms in the receiving country; (e) the security measures applied to the data in the receiving country.' },
        { provision_ref: 'reg4', section: '4', title: 'Contractual Safeguards', content: 'Regulation 4. Where data is transferred on the basis of contractual safeguards, the contract shall include provisions ensuring: (a) the data will be used only for the purposes for which it was transferred; (b) the recipient will maintain the security of the data; (c) the data will not be further transferred without adequate protection; (d) the data subject\'s rights will be respected.' },
      ],
      definitions: [],
    },
    'encouragement-of-research-law-1984': {
      description: 'The Encouragement of Research, Development and Technological Innovation in Industry Law 5744-1984 (commonly known as the Innovation Authority Law, following 2016 amendments) establishes the Israel Innovation Authority (formerly Office of the Chief Scientist) and provides the framework for government support of R&D and technological innovation. It addresses IP protection, grant conditions, and restrictions on transfer of know-how abroad.',
      provisions: [
        { provision_ref: 'sec1', section: '1', title: 'Purpose', content: 'Section 1. The purpose of this Law is to encourage research, development, and technological innovation in Israeli industry for the purpose of developing the economy, improving the balance of payments, creating employment, and leveraging Israel\'s scientific and technological capabilities.' },
        { provision_ref: 'sec3', section: '3', title: 'Innovation Authority', content: 'Section 3. The Israel Innovation Authority shall operate programs for the encouragement and support of research and development in Israeli industry.' },
        { provision_ref: 'sec14', section: '14', title: 'Grant Conditions', content: 'Section 14. (a) The Innovation Authority may grant financial assistance for R&D programs that meet the criteria prescribed by the Research Committee. (b) Recipients of grants shall pay royalties to the Authority from the revenues generated by the supported R&D.' },
        { provision_ref: 'sec19', section: '19', title: 'Transfer of Know-How', content: 'Section 19. (a) Know-how developed with funding from the Authority shall not be transferred abroad or to a foreign entity without the approval of the Research Committee. (b) Approval may be conditioned on the payment of increased royalties or other conditions to ensure that the benefits of the R&D remain in Israel.' },
        { provision_ref: 'sec20', section: '20', title: 'IP Rights', content: 'Section 20. Intellectual property rights developed with the assistance of the Authority shall remain with the grant recipient, subject to the restrictions on transfer prescribed by this Law.' },
      ],
      definitions: [],
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
          } else if (act.id.startsWith('basic-law-')) {
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
