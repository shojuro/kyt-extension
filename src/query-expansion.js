/**
 * KYT Query Expansion Module
 * Generates format variants for dates, currency, numbers, and names
 * to improve BM25 retrieval recall.
 */

export class QueryExpander {
    constructor() {
        this.currentYear = new Date().getFullYear();
    }

    /**
     * Main entry point - expand query into variants
     * @param {string} query - Original user query
     * @returns {Object} Result with original query, variants array, and debug info
     */
    expand(query) {
        const variants = new Set([query]); // Always include original
        const expansionsApplied = [];

        // Apply each expansion type
        const dateVariants = this.expandDates(query);
        if (dateVariants.length > 0) {
            dateVariants.forEach(v => variants.add(v));
            expansionsApplied.push('date');
        }

        const currencyVariants = this.expandCurrency(query);
        if (currencyVariants.length > 0) {
            currencyVariants.forEach(v => variants.add(v));
            expansionsApplied.push('currency');
        }

        const numberVariants = this.expandNumbers(query);
        if (numberVariants.length > 0) {
            numberVariants.forEach(v => variants.add(v));
            expansionsApplied.push('number');
        }

        const nameVariants = this.expandNames(query);
        if (nameVariants.length > 0) {
            nameVariants.forEach(v => variants.add(v));
            expansionsApplied.push('name');
        }

        return {
            original: query,
            variants: Array.from(variants),
            expansionsApplied
        };
    }

    /**
     * Expand date formats (ISO, US, European, Month Names)
     */
    expandDates(query) {
        const variants = [];

        // Pattern: "March 15" or "Mar 15"
        const monthNamePattern = /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\b/gi;

        // Pattern: "2025-03-15" (ISO)
        const isoPattern = /\b(\d{4})-(\d{2})-(\d{2})\b/g;

        // Pattern: "03/15/2025" or "03/15"
        const usPattern = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;

        // Expand month name dates
        let match;
        while ((match = monthNamePattern.exec(query)) !== null) {
            const monthName = match[1];
            const day = match[2].padStart(2, '0');
            const monthNum = this.monthToNumber(monthName);

            const original = match[0];
            const year = this.currentYear;

            // Generate variants
            const isoDate = `${year}-${monthNum}-${day}`;
            const usShort = `${monthNum}/${day}`;
            const usHyphen = `${monthNum}-${day}`;
            const european = `${day} ${this.normalizeMonthName(monthName)}`;

            variants.push(query.replace(original, isoDate));
            variants.push(query.replace(original, usShort));
            variants.push(query.replace(original, usHyphen));
            variants.push(query.replace(original, european));
        }

        // Expand ISO dates
        while ((match = isoPattern.exec(query)) !== null) {
            const [full, year, month, day] = match;
            const monthName = this.numberToMonth(parseInt(month));

            variants.push(query.replace(full, `${monthName} ${parseInt(day)}`));
            variants.push(query.replace(full, `${month}/${day}`));
            variants.push(query.replace(full, `${month}-${day}`));
            variants.push(query.replace(full, `${parseInt(day)} ${monthName}`));
        }

        // Expand US format dates
        while ((match = usPattern.exec(query)) !== null) {
            const [full, month, day, year] = match;
            const monthName = this.numberToMonth(parseInt(month));
            const actualYear = year ? (year.length === 2 ? `20${year}` : year) : this.currentYear;

            variants.push(query.replace(full, `${monthName} ${parseInt(day)}`));
            variants.push(query.replace(full, `${actualYear}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`));
            variants.push(query.replace(full, `${parseInt(day)} ${monthName}`));
        }

        return variants;
    }

    /**
     * Expand currency formats ($1,200 vs $1200 vs 1200.00)
     */
    expandCurrency(query) {
        const variants = [];

        // Pattern: "$1,299.99" or "$1299" or "1299.99"
        const currencyPattern = /\$?([\d,]+)(?:\.(\d{2}))?/g;

        let match;
        while ((match = currencyPattern.exec(query)) !== null) {
            const [full, intPart, decPart] = match;

            // Skip if it's just a plain small number (likely not currency)
            const numericValue = parseInt(intPart.replace(/,/g, ''));
            if (isNaN(numericValue)) continue;
            if (numericValue < 10 && !full.includes('$') && !decPart) continue;
            const withoutCommas = intPart.replace(/,/g, '');
            const withCommas = numericValue.toLocaleString('en-US');

            // Generate variants
            if (decPart) {
                // Has decimals
                variants.push(query.replace(full, `$${withoutCommas}.${decPart}`));
                variants.push(query.replace(full, `$${withCommas}.${decPart}`));
                variants.push(query.replace(full, `${withoutCommas}.${decPart}`));
                variants.push(query.replace(full, `$${withoutCommas}`)); // Without cents
                variants.push(query.replace(full, `$${withCommas}`)); // Without cents, with commas
            } else {
                // No decimals
                variants.push(query.replace(full, `$${withoutCommas}`));
                variants.push(query.replace(full, `$${withCommas}`));
                variants.push(query.replace(full, `$${withoutCommas}.00`));
                variants.push(query.replace(full, `$${withCommas}.00`)); // With commas and .00
                variants.push(query.replace(full, `$${withoutCommas}.99`));
                variants.push(query.replace(full, `$${withCommas}.99`)); // With commas and .99
            }
        }

        return variants;
    }

    /**
     * Expand number formats (units, commas)
     */
    expandNumbers(query) {
        const variants = [];

        // Pattern: Numbers with units like "47.3 GB" or "125 Mbps"
        const numberWithUnitPattern = /\b([\d,]+(?:\.\d+)?)\s*(GB|MB|KB|TB|Mbps|Kbps|MHz|GHz|kg|lb|mi|km)\b/gi;

        let match;
        while ((match = numberWithUnitPattern.exec(query)) !== null) {
            const [full, num, unit] = match;
            const cleanNum = num.replace(/,/g, '');
            const withCommas = parseFloat(cleanNum).toLocaleString('en-US');

            // Generate variants with different number formats
            variants.push(query.replace(full, `${cleanNum} ${unit}`));
            variants.push(query.replace(full, `${cleanNum}${unit}`)); // No space
            variants.push(query.replace(full, `${withCommas} ${unit}`));
        }

        // Pattern: Plain large numbers that might be formatted
        const largeNumberPattern = /\b(\d{4,})\b/g;

        while ((match = largeNumberPattern.exec(query)) !== null) {
            const [full, num] = match;
            const asNumber = parseInt(num);
            const withCommas = asNumber.toLocaleString('en-US');

            if (withCommas !== num) {
                variants.push(query.replace(full, withCommas));
            }
        }

        return variants;
    }

    /**
     * Expand names (Titles)
     */
    expandNames(query) {
        const variants = [];

        // Pattern: Titles with names
        const titlePattern = /\b(Dr|Mr|Mrs|Ms|Prof|Doctor|Professor|Mister)\.?\s+([A-Z][a-z]+)\b/g;

        const titleExpansions = {
            'dr': ['Dr.', 'Dr', 'Doctor'],
            'doctor': ['Dr.', 'Dr', 'Doctor'],
            'mr': ['Mr.', 'Mr', 'Mister'],
            'mister': ['Mr.', 'Mr', 'Mister'],
            'mrs': ['Mrs.', 'Mrs'],
            'ms': ['Ms.', 'Ms'],
            'prof': ['Prof.', 'Prof', 'Professor'],
            'professor': ['Prof.', 'Prof', 'Professor']
        };

        let match;
        while ((match = titlePattern.exec(query)) !== null) {
            const [full, title, name] = match;
            const titleLower = title.toLowerCase().replace('.', '');

            // Add variant with just the name
            variants.push(query.replace(full, name));

            // Add variants with different title formats
            const expansions = titleExpansions[titleLower] || [];
            for (const exp of expansions) {
                if (`${exp} ${name}` !== full) {
                    variants.push(query.replace(full, `${exp} ${name}`));
                }
            }
        }

        return variants;
    }

    // Helpers
    monthToNumber(month) {
        const months = {
            'january': '01', 'jan': '01',
            'february': '02', 'feb': '02',
            'march': '03', 'mar': '03',
            'april': '04', 'apr': '04',
            'may': '05',
            'june': '06', 'jun': '06',
            'july': '07', 'jul': '07',
            'august': '08', 'aug': '08',
            'september': '09', 'sep': '09',
            'october': '10', 'oct': '10',
            'november': '11', 'nov': '11',
            'december': '12', 'dec': '12'
        };
        return months[month.toLowerCase()] || '01';
    }

    numberToMonth(num) {
        const months = ['', 'January', 'February', 'March', 'April', 'May', 'June',
            'July', 'August', 'September', 'October', 'November', 'December'];
        return months[num] || 'January';
    }

    normalizeMonthName(month) {
        const normalized = {
            'jan': 'January', 'feb': 'February', 'mar': 'March',
            'apr': 'April', 'jun': 'June', 'jul': 'July',
            'aug': 'August', 'sep': 'September', 'oct': 'October',
            'nov': 'November', 'dec': 'December'
        };
        const lower = month.toLowerCase();
        return normalized[lower] || month;
    }
}
