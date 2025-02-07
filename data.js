// data.js
export class DataManager {
    constructor() {
        this.orgLookup = new Map();
        this.originalData = null;
        this.charities = {};
        this.edgeAccumulator = {};
        this.totalCharitiesCount = 0;
        this.totalGrantsCount = 0;
        this.filterCache = new Map();
    }

    async loadData() {
        if (this.originalData) return this.originalData;

        try {
            // Load charities first
            const charitiesZipBuf = await fetch('./charities.csv.zip').then(r => r.arrayBuffer());
            const charitiesZip = await JSZip.loadAsync(charitiesZipBuf);
            const charitiesCsvString = await charitiesZip.file('charities_truncated.csv').async('string');  // Updated filename

            // Parse charities data
            await new Promise((resolve, reject) => {
                Papa.parse(charitiesCsvString, {
                    header: true,
                    skipEmptyLines: true,
                    complete: results => {
                        results.data.forEach(row => {
                            if (!row.filer_ein) return;

                            this.charities[row.filer_ein] = {
                                name: (row.filer_name || '').trim(),
                                receipt_amt: parseInt(row.receipt_amt || 0),
                                govt_amt: parseInt(row.govt_amt || 0),
                                contrib_amt: parseInt(row.contrib_amt || 0),
                                grant_amt: 0
                            };
                        });
                        this.totalCharitiesCount = Object.keys(this.charities).length;
                        resolve();
                    },
                    error: reject
                });
            });

            // Load grants data
            const grantsZipBuf = await fetch('./grants.csv.zip').then(r => r.arrayBuffer());
            const grantsZip = await JSZip.loadAsync(grantsZipBuf);
            const grantsCsvString = await grantsZip.file('grants_truncated.csv').async('string');  // Updated filename

            // Parse grants data            
            await new Promise((resolve, reject) => {
                Papa.parse(grantsCsvString, {
                    header: true,
                    skipEmptyLines: true,
                    complete: results => {
                        let count = 0;
                        results.data.forEach(row => {
                            if (!row.filer_ein || !row.grant_ein) return;
                            const tax_year = parseInt(row.tax_year) || new Date().getFullYear();
                            const amt = parseInt(row.grant_amt || 0);
                            count++;

                            if (this.charities[row.filer_ein] && this.charities[row.grant_ein]) {
                                const key = `${row.filer_ein}~${row.grant_ein}~${tax_year}`;
                                if (!this.edgeAccumulator[key]) this.edgeAccumulator[key] = { grant_amt: 0, tax_year };
                                this.edgeAccumulator[key].grant_amt += amt;
                                this.charities[row.filer_ein].grant_amt += amt;
                            }
                        });
                        this.totalGrantsCount = count;
                        resolve();
                    },
                    error: reject
                });
            });

            this.buildOrgLookup();
            this.originalData = {
                charities: Object.entries(this.charities).map(([ein, data]) => ({
                    filer_ein: ein,
                    filer_name: data.name,
                    receipt_amt: data.receipt_amt,
                    govt_amt: data.govt_amt,
                    contrib_amt: data.contrib_amt,
                    grant_amt: data.grant_amt
                })),
                grants: Object.entries(this.edgeAccumulator).map(([key, value]) => {
                    const [filer, grantee, tax_year] = key.split('~');
                    return {
                        filer_ein: filer,
                        grant_ein: grantee,
                        grant_amt: value.grant_amt,
                        tax_year: parseInt(tax_year)
                    };
                })
            };

            return this.originalData;

        } catch (error) {
            throw new Error(`Failed to load data: ${error.message}`);
        }
    }

    async loadCharitiesData() {
        const zipBuf = await fetch('./charities.csv.zip').then(r => r.arrayBuffer());
        const zip = await JSZip.loadAsync(zipBuf);
        return zip.file('charities_truncated.csv').async('string');
    }

    async loadGrantsData() {
        const zipBuf = await fetch('./grants.csv.zip').then(r => r.arrayBuffer());
        const zip = await JSZip.loadAsync(zipBuf);
        return zip.file('grants_truncated.csv').async('string');
    }

    validateData(charities, grants) {
        // Validate charities data with new fields
        const hasValidCharities = charities.every(charity =>
            charity.filer_ein &&
            charity.filer_name &&
            !isNaN(parseFloat(charity.receipt_amt || '0')) &&
            !isNaN(parseFloat(charity.govt_amt || '0')) &&
            !isNaN(parseFloat(charity.contrib_amt || '0'))
        );

        // Validate grants data
        const hasValidGrants = grants.every(grant =>
            grant.filer_ein &&
            grant.grant_ein &&
            !isNaN(parseFloat(grant.grant_amt || '0'))
        );

        return hasValidCharities && hasValidGrants;
    }

    buildOrgLookup() {
        this.orgLookup.clear();
        for (const [ein, data] of Object.entries(this.charities)) {
            this.orgLookup.set(ein, data.name);
            const searchStr = `${ein} ${data.name.toLowerCase()}`;
            this.orgLookup.set(searchStr, ein);
        }
    }

    getConnectedOrgs(startEIN, depth) {
        if (!startEIN || !this.originalData || depth < 0) {
            return new Map();
        }

        const connected = new Map();
        connected.set(startEIN, 0);

        // If depth is 0, only return the starting organization
        if (depth === 0) {
            return connected;
        }

        let currentLevel = 0;
        let frontier = new Set([startEIN]);

        while (currentLevel < depth && frontier.size > 0) {
            const newFrontier = new Set();

            for (const ein of frontier) {
                this.originalData.grants.forEach(grant => {
                    if (grant.filer_ein === ein && !connected.has(grant.grant_ein)) {
                        connected.set(grant.grant_ein, currentLevel + 1);
                        newFrontier.add(grant.grant_ein);
                    }
                    if (grant.grant_ein === ein && !connected.has(grant.filer_ein)) {
                        connected.set(grant.filer_ein, currentLevel + 1);
                        newFrontier.add(grant.filer_ein);
                    }
                });
            }

            frontier = newFrontier;
            currentLevel++;
        }

        return connected;
    }

    filterData(filters) {
        const { minAmount, maxOrgs, orgFilter, depth, selectedYears } = filters;
    
        // First, verify the organization exists
        if (!this.charities[orgFilter]) {
            console.warn('Organization not found:', orgFilter);
            return this.createEmptyResult(orgFilter);
        }
    
        // Get max grant for root org and determine if warning needed
        const maxRootGrant = this.getMaxGrantForOrg(orgFilter);
        const showWarning = maxRootGrant < minAmount;
    
        // Step 1: Get root org's grants within selected years (regardless of amount)
        const rootGrants = this.originalData.grants.filter(grant =>
            (grant.filer_ein === orgFilter || grant.grant_ein === orgFilter) &&
            selectedYears.includes(grant.tax_year)
        );
    
        // If root has no grants in selected years, return early
        if (rootGrants.length === 0) {
            return {
                grants: [],
                orgs: new Set([orgFilter]),
                connected: new Map([[orgFilter, 0]]),
                stats: {
                    ...this.calculateDetailedStats([]),
                    maxRootGrant,
                    showWarning
                }
            };
        }
    
        // Step 2: Get other grants that meet minimum amount
        const otherGrants = this.originalData.grants.filter(grant =>
            grant.filer_ein !== orgFilter &&
            grant.grant_ein !== orgFilter &&
            parseFloat(grant.grant_amt) >= minAmount &&
            selectedYears.includes(grant.tax_year)
        );
    
        // Combine root grants with filtered other grants
        const filteredGrants = [...rootGrants, ...otherGrants];
    
        // Step 3: Build connection map from root
        const connected = new Map([[orgFilter, 0]]);
        let currentDepth = 0;
        let addedNewOrgs = true;
    
        while (currentDepth < depth && addedNewOrgs) {
            addedNewOrgs = false;
    
            filteredGrants.forEach(grant => {
                const connections = [
                    { from: grant.filer_ein, to: grant.grant_ein },
                    { from: grant.grant_ein, to: grant.filer_ein }
                ];
    
                connections.forEach(({ from, to }) => {
                    if (connected.has(from) && connected.get(from) === currentDepth && !connected.has(to)) {
                        connected.set(to, currentDepth + 1);
                        addedNewOrgs = true;
                    }
                });
            });
    
            currentDepth++;
        }
    
        // Step 4: Filter grants to only those between connected organizations
        const connectedGrants = filteredGrants.filter(grant => {
            const sourceDepth = connected.get(grant.filer_ein);
            const targetDepth = connected.get(grant.grant_ein);
            return sourceDepth !== undefined && targetDepth !== undefined;
        });
    
        // Step 5: Apply organization limit, ensuring root is always included
        const { filteredGrants: finalGrants, topOrgs } = this.limitToTopOrgsWithRoot(
            connectedGrants,
            maxOrgs,
            orgFilter
        );
    
        const detailedStats = this.calculateDetailedStats(finalGrants);
    
        return {
            grants: finalGrants,
            orgs: topOrgs,
            connected,
            stats: {
                ...detailedStats,
                maxRootGrant,
                showWarning,
                orgCount: topOrgs.size,
                grantCount: finalGrants.length,
                totalGrants: this.totalGrantsCount
            },
            filters: filters
        };
    }

    getMaxGrantForOrg(orgEin) {
        if (!this.originalData || !this.originalData.grants) {
            return 0;
        }
        
        let maxGrant = 0;
        this.originalData.grants.forEach(grant => {
            if ((grant.filer_ein === orgEin || grant.grant_ein === orgEin)) {
                const grantAmount = parseFloat(grant.grant_amt);
                if (!isNaN(grantAmount) && grantAmount > maxGrant) {
                    maxGrant = grantAmount;
                }
            }
        });
        return maxGrant;
    }

    createEmptyResult(orgFilter) {
        return {
            grants: [],
            orgs: new Set([orgFilter]),
            connected: new Map([[orgFilter, 0]]),
            stats: {
                orgCount: 1,
                grantCount: 0,
                totalGrants: this.totalGrantsCount
            }
        };
    }

    checkOrganization(ein) {

        // Check if org exists in charities
        const charity = this.charities[ein];

        // Count grants where org is filer
        const grantsAsFiler = this.originalData.grants.filter(g => g.filer_ein === ein);

        // Count grants where org is recipient
        const grantsAsRecipient = this.originalData.grants.filter(g => g.grant_ein === ein);

        return {
            exists: !!charity,
            grantsGiven: grantsAsFiler.length,
            grantsReceived: grantsAsRecipient.length
        };
    }


    createResult(grants, orgs, connected) {
        return {
            grants,
            orgs,
            connected,
            stats: {
                orgCount: orgs.size,
                grantCount: grants.length,
                totalGrants: this.totalGrantsCount,
                totalCharities: this.totalCharitiesCount
            }
        };
    }

    limitToTopOrgsWithRoot(grants, maxOrgs, rootEIN) {
        // Calculate volume for all organizations
        const orgVolume = new Map();
        grants.forEach(grant => {
            const amount = parseFloat(grant.grant_amt);
            orgVolume.set(grant.filer_ein,
                (orgVolume.get(grant.filer_ein) || 0) + amount);
            orgVolume.set(grant.grant_ein,
                (orgVolume.get(grant.grant_ein) || 0) + amount);
        });

        // Always include root organization
        const topOrgs = new Set([rootEIN]);

        // Get all organizations connected directly to root
        const rootConnections = grants.filter(grant =>
            grant.filer_ein === rootEIN || grant.grant_ein === rootEIN
        ).map(grant => grant.filer_ein === rootEIN ? grant.grant_ein : grant.filer_ein);

        // Add root connections to volume map if not already there
        rootConnections.forEach(ein => {
            if (!orgVolume.has(ein)) {
                orgVolume.set(ein, 0);
            }
        });

        // Sort organizations by volume, excluding root
        const sortedOrgs = Array.from(orgVolume.entries())
            .filter(([ein]) => ein !== rootEIN)
            .sort((a, b) => b[1] - a[1]);

        // Take only up to maxOrgs - 1 (leaving space for root)
        const remainingSlots = Math.max(0, maxOrgs - 1);
        sortedOrgs.slice(0, remainingSlots).forEach(([ein]) => {
            topOrgs.add(ein);
        });

        // Filter grants to only include those between top organizations
        const finalGrants = grants.filter(grant =>
            topOrgs.has(grant.filer_ein) && topOrgs.has(grant.grant_ein)
        );

        return {
            filteredGrants: finalGrants,
            topOrgs,
            stats: {
                orgCount: topOrgs.size,
                grantCount: finalGrants.length
            }
        };
    }

    filterGrantsByConnected(grants, connectedOrgs) {
        return grants.filter(grant =>
            connectedOrgs.has(grant.filer_ein) &&
            connectedOrgs.has(grant.grant_ein)
        );
    }

    limitToTopOrgs(grants, maxOrgs) {
        const orgVolume = this.calculateOrgVolumes(grants);
        const topOrgs = new Set(
            Array.from(orgVolume.entries())
                .sort((a, b) => b[1] - a[1])
                .slice(0, maxOrgs)
                .map(([ein]) => ein)
        );

        const finalGrants = grants.filter(
            grant => topOrgs.has(grant.filer_ein) &&
                topOrgs.has(grant.grant_ein)
        );

        return {
            filteredGrants: finalGrants,
            topOrgs,
            stats: {
                orgCount: topOrgs.size,
                grantCount: finalGrants.length,
                totalGrants: this.originalData.grants.length
            }
        };
    }

    calculateOrgVolumes(grants) {
        const orgVolume = new Map();
        grants.forEach(grant => {
            const amount = parseFloat(grant.grant_amt);
            orgVolume.set(grant.filer_ein,
                (orgVolume.get(grant.filer_ein) || 0) + amount);
            orgVolume.set(grant.grant_ein,
                (orgVolume.get(grant.grant_ein) || 0) + amount);
        });
        return orgVolume;
    }

    searchOrganizations(searchText) {
        if (!searchText || searchText.length < 2) return [];

        const input = searchText.toLowerCase();
        return Array.from(this.orgLookup.entries())
            .filter(([key]) =>
                typeof key === 'string' &&
                key.toLowerCase().includes(input)
            )
            .slice(0, 5)
            .map(([key, value]) => ({
                ein: typeof value === 'string' ? value : key,
                name: this.orgLookup.get(value) || 'Unknown Organization'
            }));
    }

    getAvailableYears(ein) {
        if (!ein) return [2023, 2022, 2021];

        const years = new Set();
        this.originalData.grants.forEach(grant => {
            if ((grant.filer_ein === ein || grant.grant_ein === ein) && grant.tax_year) {
                years.add(parseInt(grant.tax_year));
            }
        });
        const yearsArray = Array.from(years).sort((a, b) => b - a);
        return yearsArray.length > 0 ? yearsArray : [2023, 2022, 2021]; // Fallback to defaults
    }

    getOrgDetails(ein) {
        const charity = this.originalData.charities.find(c => c.filer_ein === ein);
        if (!charity) return null;

        return {
            name: charity.filer_name,
            ein: charity.filer_ein,
            receipts: charity.receipt_amt,
            govtFunds: charity.govt_amt,
            contributions: charity.contrib_amt,
            grantsGiven: charity.grant_amt
        };
    }

    calculateTaxpayerImpact(eins) {
        return eins.reduce((total, ein) => {
            const org = this.getOrgDetails(ein);
            return total + (org ? org.govtFunds : 0);
        }, 0);
    }

    calculateDetailedStats(grants) {
        // Handle empty grants array
        if (!grants || grants.length === 0) {
            return {
                grantCount: 0,
                totalAmount: 0,
                averageAmount: 0,
                standardDeviation: 0
            };
        }

        // Calculate grant amounts, filtering out invalid values
        const grantAmounts = grants
            .map(grant => parseFloat(grant.grant_amt))
            .filter(amount => !isNaN(amount));

        if (grantAmounts.length === 0) {
            return {
                grantCount: 0,
                totalAmount: 0,
                averageAmount: 0,
                standardDeviation: 0
            };
        }

        // Calculate basic statistics
        const totalAmount = grantAmounts.reduce((sum, amt) => sum + amt, 0);
        const averageAmount = totalAmount / grantAmounts.length;

        // Calculate standard deviation
        const squareDiffs = grantAmounts.map(value => {
            const diff = value - averageAmount;
            return diff * diff;
        });
        const avgSquareDiff = squareDiffs.reduce((sum, value) => sum + value, 0) / grantAmounts.length;
        const standardDeviation = Math.sqrt(avgSquareDiff);

        return {
            grantCount: grants.length,
            totalAmount: totalAmount,
            averageAmount: averageAmount,
            standardDeviation: standardDeviation
        };
    }
}