#!/usr/bin/env node
/**
 * Data Fetcher Script - Downloads City of Toronto Recreation Data
 * Run this locally or via CI/CD to update the static JSON files
 * 
 * Usage: node fetch-skate-data.js
 * 
 * This bypasses CORS because Node.js isn't a browser!
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const PACKAGE_ID = '1a5be46a-4039-48cd-a2d2-8e702abf9516';
const BASE_URL = 'https://ckan0.cf.opendata.inter.prod-toronto.ca/api/3/action';
const OUTPUT_DIR = path.join(__dirname, 'projects', 'data');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

/**
 * Make HTTPS request and return JSON
 */
function fetchJSON(url) {
    return new Promise((resolve, reject) => {
        console.log(`Fetching: ${url.substring(0, 80)}...`);
        
        https.get(url, (res) => {
            let data = '';
            
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`Failed to parse JSON: ${e.message}`));
                }
            });
            res.on('error', reject);
        }).on('error', reject);
    });
}

/**
 * Fetch all records from a datastore resource with pagination
 */
async function fetchAllRecords(resourceId, resourceName) {
    let allRecords = [];
    let offset = 0;
    const limit = 10000; // Larger batch for efficiency
    let total = Infinity;
    
    console.log(`\n📥 Fetching ${resourceName}...`);
    
    while (offset < total) {
        const url = `${BASE_URL}/datastore_search?id=${resourceId}&limit=${limit}&offset=${offset}`;
        const result = await fetchJSON(url);
        
        if (result.success) {
            allRecords = allRecords.concat(result.result.records);
            total = result.result.total;
            console.log(`   Progress: ${allRecords.length}/${total} records`);
        } else {
            throw new Error(`API returned error for ${resourceName}`);
        }
        
        offset += limit;
        
        // Small delay to be nice to the server
        await new Promise(r => setTimeout(r, 100));
    }
    
    console.log(`   ✅ Complete: ${allRecords.length} records`);
    return allRecords;
}

/**
 * Filter for skating-related programs only
 */
function filterSkatingPrograms(programs) {
    return programs.filter(p => {
        // Field names from the actual API
        const courseTitle = (p['Course Title'] || '').toLowerCase();
        const section = (p['Section'] || '').toLowerCase();
        
        return section.includes('skate') || 
               courseTitle.includes('skate') || 
               courseTitle.includes('shinny') || 
               courseTitle.includes('hockey') ||
               courseTitle.includes('ringette') ||
               courseTitle.includes('stick and puck') ||
               section.includes('skating');
    });
}

/**
 * Main function
 */
async function main() {
    console.log('🛼 Toronto Skating Data Fetcher');
    console.log('================================\n');
    
    try {
        // Step 1: Get package info to find resource IDs
        console.log('📋 Fetching package metadata...');
        const packageData = await fetchJSON(`${BASE_URL}/package_show?id=${PACKAGE_ID}`);
        
        if (!packageData.success) {
            throw new Error('Failed to fetch package info');
        }
        
        const resources = packageData.result.resources.filter(r => r.datastore_active);
        console.log(`   Found ${resources.length} datastore resources\n`);
        
        // Identify each resource
        const resourceMap = {};
        resources.forEach(r => {
            const name = r.name.toLowerCase();
            if (name.includes('drop')) resourceMap.dropin = r;
            else if (name.includes('registered')) resourceMap.registered = r;
            else if (name.includes('location')) resourceMap.locations = r;
            else if (name.includes('facilit')) resourceMap.facilities = r;
        });
        
        console.log('Resources identified:');
        Object.entries(resourceMap).forEach(([key, r]) => {
            console.log(`   - ${key}: ${r.name} (${r.id})`);
        });
        
        // Step 2: Fetch each dataset
        const datasets = {};
        
        // Locations (we need this for all programs)
        if (resourceMap.locations) {
            datasets.locations = await fetchAllRecords(resourceMap.locations.id, 'Locations');
        }
        
        // Drop-in programs (main focus for skating)
        if (resourceMap.dropin) {
            const allDropin = await fetchAllRecords(resourceMap.dropin.id, 'Drop-in Programs');
            datasets.dropin = filterSkatingPrograms(allDropin);
            console.log(`   🎯 Filtered to ${datasets.dropin.length} skating programs`);
        }
        
        // Facilities
        if (resourceMap.facilities) {
            datasets.facilities = await fetchAllRecords(resourceMap.facilities.id, 'Facilities');
        }
        
        // Step 3: Create a combined skating dataset with location info
        console.log('\n🔗 Joining skating programs with location data...');
        
        // Create location lookup map (check actual field names)
        const locationMap = {};
        if (datasets.locations) {
            datasets.locations.forEach(loc => {
                // Location ID can be in different formats
                const locId = loc['Location ID'] || loc.LocationID || loc.locationid;
                if (locId) locationMap[locId] = loc;
            });
            console.log(`   Built location map with ${Object.keys(locationMap).length} entries`);
        }
        
        // Enrich skating programs with location data
        const enrichedPrograms = datasets.dropin.map(program => {
            const locId = program['Location ID'] || program.LocationID;
            const location = locationMap[locId] || {};
            
            // Build address from components
            let address = '';
            if (location['Street No'] && location['Street No'] !== 'None') {
                address = location['Street No'];
                if (location['Street No Suffix'] && location['Street No Suffix'] !== 'None') {
                    address += location['Street No Suffix'];
                }
                address += ' ';
            }
            if (location['Street Name']) address += location['Street Name'] + ' ';
            if (location['Street Type']) address += location['Street Type'] + ' ';
            if (location['Street Direction'] && location['Street Direction'] !== 'None') {
                address += location['Street Direction'];
            }
            address = address.trim();
            
            return {
                ...program,
                // Normalize field names for the frontend
                Activity: program['Course Title'],
                Category: program['Section'],
                LocationName: location['Location Name'] || '',
                LocationType: location['Location Type'] || '',
                Address: address,
                District: location['District'] || '',
                PostalCode: location['Postal Code'] !== 'None' ? location['Postal Code'] : '',
                Accessibility: location['Accessibility'] !== 'None' ? location['Accessibility'] : '',
                TTCInfo: location['TTC Information'] !== 'None' ? location['TTC Information'] : '',
                Intersection: location['Intersection'] !== 'None' ? location['Intersection'] : '',
                // Normalize time fields
                'Start Time': program['Start Hour'] !== undefined ? 
                    `${String(program['Start Hour']).padStart(2,'0')}:${String(program['Start Minute'] || 0).padStart(2,'0')}` : '',
                'End Time': program['End Hour'] !== undefined ? 
                    `${String(program['End Hour']).padStart(2,'0')}:${String(program['End Min'] || 0).padStart(2,'0')}` : '',
                'Day of Week': program['DayOftheWeek'] || '',
                'Start Date': program['First Date'] || '',
                'End Date': program['Last Date'] || ''
            };
        });
        
        // Step 4: Save files
        console.log('\n💾 Saving data files...');
        
        const metadata = {
            lastUpdated: new Date().toISOString(),
            source: 'City of Toronto Open Data',
            packageId: PACKAGE_ID,
            counts: {
                skatingPrograms: enrichedPrograms.length,
                locations: datasets.locations?.length || 0,
                facilities: datasets.facilities?.length || 0
            }
        };
        
        // Save skating programs (the main file we need)
        const skatingFile = path.join(OUTPUT_DIR, 'skating-programs.json');
        fs.writeFileSync(skatingFile, JSON.stringify({
            metadata,
            programs: enrichedPrograms
        }, null, 2));
        console.log(`   ✅ ${skatingFile} (${(fs.statSync(skatingFile).size / 1024).toFixed(1)} KB)`);
        
        // Save locations (smaller, useful for map features)
        const locationsFile = path.join(OUTPUT_DIR, 'locations.json');
        fs.writeFileSync(locationsFile, JSON.stringify({
            metadata: { ...metadata, type: 'locations' },
            locations: datasets.locations || []
        }, null, 2));
        console.log(`   ✅ ${locationsFile} (${(fs.statSync(locationsFile).size / 1024).toFixed(1)} KB)`);
        
        // Save facilities
        const facilitiesFile = path.join(OUTPUT_DIR, 'facilities.json');
        fs.writeFileSync(facilitiesFile, JSON.stringify({
            metadata: { ...metadata, type: 'facilities' },
            facilities: datasets.facilities || []
        }, null, 2));
        console.log(`   ✅ ${facilitiesFile} (${(fs.statSync(facilitiesFile).size / 1024).toFixed(1)} KB)`);
        
        console.log('\n✨ Done! Data files are ready in:', OUTPUT_DIR);
        console.log('\nNext steps:');
        console.log('1. Deploy these JSON files with your site');
        console.log('2. The skate.html will load from these local files');
        console.log('3. Re-run this script weekly to update data\n');
        
    } catch (error) {
        console.error('\n❌ Error:', error.message);
        process.exit(1);
    }
}

main();
