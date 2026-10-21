const {onRequest} = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const axios = require("axios");

exports.vanLocation = onRequest(
    {
      timeoutSeconds: 30,
      memory: "256MiB",
    // region: "us-central1",
    },
    async (req, res) => {
      /**
       * Expands common address abbreviations to full words
       * @param {string} text - Address text to expand
       * @return {string} Expanded address text
       */
      function expandAbbreviations(text) {
        return String(text || "")
            .replace(/\bE\b/g, "East")
            .replace(/\bW\b/g, "West")
            .replace(/\bN\b/g, "North")
            .replace(/\bS\b/g, "South")
            .replace(/\bSt\b/g, "Street")
            .replace(/\bRd\b/g, "Road")
            .replace(/\bAve\b/g, "Avenue")
            .replace(/\bBlvd\b/g, "Boulevard")
            .replace(/\bDr\b/g, "Drive")
            .replace(/\bCt\b/g, "Court")
            .replace(/\bLn\b/g, "Lane")
            .replace(/\bPkwy\b/g, "Parkway")
            .replace(/\bHwy\b/g, "Highway")
            .replace(/\bIL\b/g, "Illinois")
            .replace(/\bNJ\b/g, "New Jersey")
            .replace(/\bNY\b/g, "New York")
            .replace(/\bUSA\b/g, "")
            .replace(/\s+/g, " ")
            .trim();
      }

      /**
       * Converts numbers to English words
       * @param {number} num - Number to convert
       * @return {string} Number in English words
       */
      function numberToEnglish(num) {
        const ones = [
          "zero", "one", "two", "three", "four", "five", "six",
          "seven", "eight", "nine",
        ];
        const teens = [
          "ten", "eleven", "twelve", "thirteen", "fourteen",
          "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
        ];
        const tens = [
          "", "", "twenty", "thirty", "forty", "fifty",
          "sixty", "seventy", "eighty", "ninety",
        ];

        if (num < 10) return ones[num];
        if (num < 20) return teens[num - 10];
        if (num < 100) {
          const t = Math.floor(num / 10);
          const o = num % 10;
          return o ? `${tens[t]} ${ones[o]}` : tens[t];
        }
        if (num < 1000) {
          const h = Math.floor(num / 100);
          const rest = num % 100;
          return rest ?
          `${ones[h]} hundred ${numberToEnglish(rest)}` :
          `${ones[h]} hundred`;
        }
        if (num < 1000000) {
          const th = Math.floor(num / 1000);
          const rest = num % 1000;
          return rest ?
          `${numberToEnglish(th)} thousand ${numberToEnglish(rest)}` :
          `${numberToEnglish(th)} thousand`;
        }
        return String(num);
      }

      /**
       * Converts numbers in text to English words
       * @param {string} text - Text containing numbers
       * @return {string} Text with numbers converted to words
       */
      function numbersToWords(text) {
        return String(text || "").replace(/\d+/g, (m) =>
          numberToEnglish(parseInt(m, 10)));
      }

      /**
       * Removes zip codes and noise from address text
       * @param {string} text - Address text to clean
       * @return {string} Cleaned address text
       */
      function removeZipAndNoise(text) {
        return String(text || "")
            .replace(/\b\d{5}(?:-\d{4})?\b/g, "")
            .replace(
                /\b[23456789CFGHJMPQRVWX]{4,}\+[23456789CFGHJMPQRVWX]{2,}\b/ig,
                "",
            )
            .replace(/\s+,/g, ",")
            .replace(/,\s*,/g, ",")
            .replace(/^,\s*/g, "")
            .replace(/,\s*$/g, "")
            .replace(/\s+/g, " ")
            .trim();
      }

      /**
       * Cleans and formats address text
       * @param {string} text - Address text to clean
       * @return {string} Cleaned address text
       */
      function cleanAddress(text) {
        return removeZipAndNoise(text)
            .replace(/\bdaj\b/gi, "daish")
            .replace(/\s+,/g, ",")
            .replace(/,\s*,/g, ",")
            .replace(/^,\s*/g, "")
            .replace(/,\s*$/g, "")
            .replace(/\s+/g, " ")
            .trim();
      }

      /**
       * Converts address to slow English format for speech
       * @param {string} text - Address text to convert
       * @return {string} Address in slow English format
       */
      function makeSlowEnglish(text) {
        return numbersToWords(expandAbbreviations(cleanAddress(text)))
            .replace(/,/g, ", ")
            .replace(/-/g, " ")
            .replace(/\s+/g, " ")
            .replace(/New York$/, "New York")
            .trim();
      }

      /**
       * Checks if address contains a street number
       * @param {string} a - Address to check
       * @return {boolean} True if street number found
       */
      function hasStreetNumber(a) {
        return /\b\d+\b/.test(String(a || ""));
      }

      /**
       * Checks if address contains a street name
       * @param {string} a - Address to check
       * @return {boolean} True if street name found
       */
      function hasStreetName(a) {
        const text = String(a || "").toLowerCase();
        // Treat "ctr hl road" as having no street name
        if (text.includes("ctr hl road")) return false;
        
        return new RegExp(
            "\\b(" +
            "street|road|avenue|boulevard|drive|court|lane|parkway|highway|" +
            "st|rd|ave|blvd|dr|ct|ln|pkwy|hwy" +
            ")\\b",
            "i"
        ).test(text);
      }

      /**
       * Checks if address is considered bad/invalid
       * @param {string} a - Address to check
       * @return {boolean} True if address is bad
       */
      function isBadAddress(a) {
        const s = String(a || "").trim();
        return (
          !s ||
        /^Never Reported$/i.test(s) ||
        /Unnamed Road/i.test(s) ||
        /\b[23456789CFGHJMPQRVWX]{4,}\+[23456789CFGHJMPQRVWX]{2,}\b/i.test(s)
        );
      }

      /**
       * Picks the best Google Maps result from a list
       * @param {Array} results - Google Maps results
       * @return {string} Best formatted address
       */
      function pickBestGoogleResult(results) {
        if (!Array.isArray(results) || results.length === 0) return "";

        const list = results
            .map((r) => ({
              addr: String(
                  r && r.formatted_address ? r.formatted_address : "",
              ).trim(),
              types: Array.isArray(r && r.types ? r.types : []) ? r.types : [],
            }))
            .filter((r) => r.addr);

        const good = (r) => !isBadAddress(r.addr) &&
            !r.types.includes("plus_code");

        let r = list.find((x) => x.types.includes("street_address") && good(x));
        if (r) return r.addr;

        r = list.find((x) =>
          (x.types.includes("premise") || x.types.includes("subpremise")) &&
            good(x),
        );
        if (r) return r.addr;

        r = list.find((x) => x.types.includes("route") && good(x));
        if (r) return r.addr;

        r = list.find((x) => good(x));
        return r ? r.addr : "";
      }

      /**
       * Chooses the best address between Google and tracker data
       * @param {string} google - Google Maps address
       * @param {string} tracker - GPS tracker address
       * @return {string} Best address
       */
      function chooseBestAddress(google, tracker) {
        const g = cleanAddress(google);
        const t = cleanAddress(tracker);

        const gGood = g && !isBadAddress(g);
        const tGood = t && !isBadAddress(t);

        const gNum = hasStreetNumber(g);
        const tNum = hasStreetNumber(t);

        const gName = hasStreetName(g);
        const tName = hasStreetName(t);

        if (gGood && tGood) {
          if (gNum && !tNum) return g;
          if (!gNum && tNum) return t;

          if (gName && !tName) return g;
          if (!gName && tName) return t;

          // default to tracker
          return t;
        }

        if (tGood) return t;
        if (gGood) return g;

        return t || g || "";
      }

      try {
        const sidFromRequest = String(
            req.query.sid || (req.body && req.body.sid) || "",
        ).trim();

        const deviceKey = String(
            req.query.device_key || (req.body && req.body.device_key) || "",
        ).trim();

        const mapsApiKey = String(
            req.query.key || (req.body && req.body.key) ||
            process.env.GOOGLE_MAPS_KEY,
        ).trim();

        logger.info(`Using API key: ${mapsApiKey.substring(0, 10)}...`);

        let deviceSidMap = {};
        if (process.env.DEVICE_SID_MAP) {
          try {
            deviceSidMap = JSON.parse(process.env.DEVICE_SID_MAP);
          } catch (e) {
            logger.error("Invalid DEVICE_SID_MAP JSON", e);
          }
        }

        const sid = sidFromRequest || deviceSidMap[deviceKey];

        if (!sid) {
          const message = "The van location is unavailable.";
          res.status(200).type("text/plain").send(message);
          return;
        }

        // Share links use geojsonshare.aspx (geojson.aspx returns empty for share SIDs).
        const trackingUrl =
          "https://portal.gps-tracking.com/geojsonshare.aspx" +
          "?action=shareinit&sid=" + encodeURIComponent(sid);
        const trackingResponse = await axios.get(trackingUrl, {timeout: 10000});

        const feature = trackingResponse.data &&
          trackingResponse.data.features &&
          trackingResponse.data.features[0];
        if (!feature) throw new Error("No location data found");

        const coords = feature && feature.geometry &&
            feature.geometry.coordinates;
        if (!Array.isArray(coords) || coords.length < 2) {
          throw new Error("No coordinates found");
        }

        const lon = coords[0];
        const lat = coords[1];

        const trackerAddress = String(
            feature && feature.properties && feature.properties.addy || "",
        ).trim();

        const trackerClean = cleanAddress(trackerAddress);

        // Log the addresses for debugging
        logger.info(`Raw tracker address: "${trackerAddress}"`);
        logger.info(`Cleaned tracker address: "${trackerClean}"`);

        const trackerGood = trackerClean && !isBadAddress(trackerClean);
        const trackerHasNumber = hasStreetNumber(trackerClean);
        const trackerHasStreet = hasStreetName(trackerClean);

        const trackerPreciseEnough = trackerGood &&
            trackerHasNumber && trackerHasStreet;

        // Force Google call for problematic streets
        const problematicStreets = [
          "ctr hl road",
          "center hall road",
          "old county rt",
          "old country road town of monroe",
        ];
        const hasProblematicStreet = problematicStreets.some((street) =>
          trackerClean.toLowerCase().includes(street),
        );

        const shouldCallGoogle = !trackerPreciseEnough || hasProblematicStreet;

        let googleAddress = "";
        if (shouldCallGoogle) {
          logger.info("Calling Google Maps API - tracker not precise enough or has problematic street");
          try {
            const geocodeUrl =
              "https://maps.googleapis.com/maps/api/geocode/json" +
              "?latlng=" + lat + "," + lon +
              "&key=" + mapsApiKey;
            const geo = await axios.get(geocodeUrl, {timeout: 10000});
            const results = geo && geo.data && geo.data.results || [];
            googleAddress = pickBestGoogleResult(results);
            logger.info(`Google Maps response: "${googleAddress}"`);
          } catch (e) {
            logger.error("Google Maps API failed", e);
          }
        } else {
          logger.info("Using tracker address - precise enough and no problematic streets");
        }

        const address = chooseBestAddress(googleAddress, trackerAddress);

        if (!address) {
          throw new Error("No address found");
        }

        const spokenAddress = makeSlowEnglish(address);
        const message = `The van is currently at, ${spokenAddress}`;
        res
            .status(200)
            .type("text/plain")
            .send(message);
      } catch (err) {
        logger.error("Location lookup failed", err);
        const errorMessage = "The van location is unavailable right now.";
        res
            .status(200)
            .type("text/plain")
            .send(errorMessage);
      }
    },
);
