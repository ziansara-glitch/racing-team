-- Il nome corretto dell'organizzazione è "Racing Team" (la 0002 inseriva "Recent Team").
-- Additiva e idempotente: tocca solo l'organizzazione predefinita e solo se ha ancora il nome originale,
-- quindi non sovrascrive un nome già scelto a mano. Lo slug non è usato in nessun URL.
UPDATE organizations
   SET name = 'Racing Team', slug = 'racing-team'
 WHERE id = 1 AND name = 'Recent Team' AND slug = 'recent-team';
