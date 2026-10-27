# JCB sponsor banner assets

JCB 5.2.0 and 6.2.0 declare seven sponsor banners and normally download their artwork on first use. Their wide Community Magazine entry downloads the 120×600 image while its HTML requests the 728×90 filename, leaving the displayed image missing.

The browser package includes all seven original images unchanged, downloaded from the pinned `vdm-io/jcb-external` commit in `assets.json`. Every image is checked against its SHA-256, size and the content checksum used by JCB. The Agerix image in that repository was also compared with the original sponsor URL and has identical bytes. Existing sponsor destinations, artwork, text and rotating choices are retained.

`scripts/jcb-banners.mjs` corrects only the wide magazine entry's download filename and corresponding content checksum. It verifies the entire helper's original and corrected SHA-256 for each supported JCB package. The build then checks every banner entry's downloaded filename against its HTML image path, includes every referenced image, and records source URLs, checksums, dimensions, installed paths and helper hashes in package provenance.

The files install under `administrator/components/com_componentbuilder/assets/images/banner/`, where JCB's existing content checks can find them immediately. Sponsor artwork remains the work of its respective creators. Original references and visible credits remain in JCB.
