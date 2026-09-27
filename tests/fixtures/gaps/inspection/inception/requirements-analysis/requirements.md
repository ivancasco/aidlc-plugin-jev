# Requirements: Site Inspection App

## Functional Requirements

- **FR1** An inspector signs in with their company account and sees the sites assigned to them. Given an inspector assigned to 3 sites, when they sign in, then exactly those 3 sites are listed.
- **FR2** An inspector completes a checklist for a site, marking each item pass or fail with an optional photo and note. Given a checklist of 25 items, when the inspector marks all 25 and submits, then the inspection is saved with the inspector's name, the site and the time.
- **FR3** A failed item notifies the site manager. Given an inspection with at least one failed item, when it is submitted, then the site's manager receives an email listing the failed items within 5 minutes.
- **FR4** A site manager sees every inspection for their sites, newest first, and can filter by failed items.
- **FR5** Checklist templates are maintained by the safety lead, who can add, change and retire checklist items.

## Non-Functional Requirements

- **NFR1** Photos up to 10 MB each are accepted, up to 20 per inspection.
- **NFR2** Inspection records are kept for 7 years, as required by the company's safety policy, then deleted.

## Out of Scope

- Integration with the payroll system.
