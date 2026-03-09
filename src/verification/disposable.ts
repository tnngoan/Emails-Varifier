// ─── Disposable Email & Role-Based Address Detection ─────────────────────────
//
// Signals returned:
//   isDisposable — domain is a known temporary/throw-away email provider
//   isRoleBased  — local-part is a generic function alias, not an individual
//
// Neither flag is a hard rejection by itself; together they inform the risk
// score. Disposable emails are short-circuited in the pipeline (treated as
// INVALID). Role-based addresses continue through SMTP but get a higher score.

// ─── Disposable Domains ───────────────────────────────────────────────────────
// Curated list of widely-used temporary / burner email providers.
const DISPOSABLE_DOMAINS = new Set<string>([
  // ── Mailinator family ─────────────────────────────────────────────────────
  'mailinator.com','notmailinator.com','mytrashmail.com',
  // ── Guerrilla Mail family ─────────────────────────────────────────────────
  'guerrillamail.com','guerrillamail.net','guerrillamail.org','guerrillamail.de',
  'guerrillamail.biz','guerrillamail.info','guerrillamailblock.com','grr.la',
  'sharklasers.com',
  // ── YOPmail ───────────────────────────────────────────────────────────────
  'yopmail.com','yopmail.fr','yopmail.net',
  // ── 10 Minute Mail ───────────────────────────────────────────────────────
  '10minutemail.com','10minutemail.net','10minutemail.org',
  '10minutemail.de','10minutemail.us',
  // ── Trashmail family ─────────────────────────────────────────────────────
  'trashmail.com','trashmail.net','trashmail.org','trashmail.at',
  'trashmail.io','trashmail.me','trashmail.xyz','trashmail.de',
  'trash-mail.at','trash-mail.com','trash-mail.de','trash-mail.io',
  // ── Maildrop / Mailnull ───────────────────────────────────────────────────
  'maildrop.cc','mailnull.com','mailnesia.com','mailnew.com','mailcat.biz',
  'mailcatch.com','mailmoat.com','mailscrap.com',
  // ── Temp-mail services ────────────────────────────────────────────────────
  'tempmail.com','temp-mail.org','temp-mail.io','tempinbox.com',
  'temporaryemail.net','temporaryemail.us','temporaryinbox.com',
  'throwam.com','throwaway.email','tempr.email','tempail.com','tempalias.com',
  // ── Discard / Fake inbox ─────────────────────────────────────────────────
  'dispostable.com','discard.email','discardmail.com','discardmail.de',
  'fakeinbox.com','fakemailgenerator.com','fake-box.com',
  // ── GetNada / GetAirmail ─────────────────────────────────────────────────
  'getnada.com','getairmail.com','get1mail.com',
  // ── Spamgourmet ───────────────────────────────────────────────────────────
  'spamgourmet.com','spamgourmet.net','spamgourmet.org',
  // ── Spam* family ─────────────────────────────────────────────────────────
  'spamex.com','spamevader.com','spamfree24.org','spambog.com','spambog.de',
  'spambog.ru','spammotel.com','spamspot.com','spaml.com','spaml.de',
  'spam4.me','spam.la','spam.su','spamfree.eu','spamgob.com','spamoff.de',
  'spamslicer.com','spamthis.co.uk','spamthisplease.com','spamtrail.com',
  'spamavert.com','spamhereplease.com',
  // ── Jetable family ───────────────────────────────────────────────────────
  'jetable.com','jetable.fr.nf','jetable.net','jetable.org',
  // ── Wegwerfmail ───────────────────────────────────────────────────────────
  'wegwerfmail.de','wegwerfmail.net','wegwerfmail.org',
  // ── Filzmail ─────────────────────────────────────────────────────────────
  'filzmail.com','filzmail.de',
  // ── Dump / Throw-away ────────────────────────────────────────────────────
  'dump-email.info','dumpmail.de','dumpyemail.com','dumpandfuck.com',
  // ── Mintemail / Mailexpire ────────────────────────────────────────────────
  'mintemail.com','mailexpire.com',
  // ── Mailzilla ────────────────────────────────────────────────────────────
  'mailzilla.com','mailzilla.org',
  // ── Dodgeit ──────────────────────────────────────────────────────────────
  'dodgit.com','dodgeit.com',
  // ── Binkmail / Bobmail ───────────────────────────────────────────────────
  'binkmail.com','bobmail.info','devnullmail.com',
  // ── Inboxalias ───────────────────────────────────────────────────────────
  'inboxalias.com','inboxclean.com','inboxclean.org',
  // ── E4ward / Easytrash ───────────────────────────────────────────────────
  'e4ward.com','easytrashmail.com',
  // ── Emailage / Emailias ───────────────────────────────────────────────────
  'emailage.cf','emailias.com','emailigo.com','emailinfive.com',
  'emailsensei.com','emailtemporanea.com','emailtemporanea.net',
  'emailtemporaneo.com','emailthe.net','emailtmp.com','emailwarden.com',
  'emailx.at.hm','emailxfer.com','emltmp.com',
  // ── Ephemail / Explodemail ────────────────────────────────────────────────
  'ephemail.net','explodemail.com','eyepaste.com',
  // ── F4k / Fightspam ──────────────────────────────────────────────────────
  'f4k.es','fightallspam.com','filtr.me','fizmail.com','flyspam.com',
  'fleckens.hu','flemail.com','frapmail.com',
  // ── Getnada / Gishpuppy ──────────────────────────────────────────────────
  'garliclife.com','getinfo.de','getonemail.com','getonemail.net',
  'ghosttexter.de','gishpuppy.com',
  // ── Haltospam ────────────────────────────────────────────────────────────
  'haltospam.com','hatespam.org','hmamail.com','hochsitze.com','hotpop.com',
  'hulapla.de',
  // ── Ieatspam ─────────────────────────────────────────────────────────────
  'ieatspam.eu','ieatspam.info','ieh-mail.de','ignoremail.com',
  'ihateyoualot.info','iheartspam.org','imails.info','inbax.tk','inbox.si',
  'inoutmail.de','inoutmail.eu','inoutmail.info','inoutmail.net',
  'ipoo.org','irish2me.com',
  // ── Junkmail ─────────────────────────────────────────────────────────────
  'jnxjn.com','jokemail.net','junk.to','junkmail.com','junkmail.ga',
  'jupimail.com',
  // ── Killmail ─────────────────────────────────────────────────────────────
  'keepmymail.com','killmail.com','killmail.net','koszmail.pl','kurzepost.de',
  // ── Lastmail ─────────────────────────────────────────────────────────────
  'laoeq.com','lastmail.co','laverb.com','legitmail.club',
  'letthemeatspam.com','lhsdv.com','link2mail.net','litedrop.com',
  'lolfreak.net','lookugly.com','lortemail.dk','lovemeleaveme.com',
  // ── Mailin8r ─────────────────────────────────────────────────────────────
  'mailin8r.com','mailincubator.com','no-spam.ws','nospam.ze.tc',
  'nospamfor.us','nospamthanks.info','nospam4.us','no-spam.com',
  // ── Owlpic ───────────────────────────────────────────────────────────────
  'owlpic.com','pjjkp.com','safetymail.info','sharedmailbox.org',
  'shortmail.net','smellfear.com','sofimail.com',
  // ── Selfdestructingmail ───────────────────────────────────────────────────
  'selfdestructingmail.com','sendspamhere.com','shieldedmail.com',
  // ── Temporaryemail ───────────────────────────────────────────────────────
  'trbvm.com','turual.com','twinmail.de','tyldd.com','uroid.com','vomoto.com',
  // ── Wh4f ─────────────────────────────────────────────────────────────────
  'wh4f.org','whyspam.me','willselfdestruct.com','wmail.cf','writeme.us',
  // ── Xagloo ───────────────────────────────────────────────────────────────
  'xagloo.com','xemaps.com','xents.com','xmaily.com','xoxy.net','xyzzy.ninja',
  // ── Zoe / Zom ────────────────────────────────────────────────────────────
  'zoemail.net','zoemail.org','zomg.info','z1p.biz',
  'zehnminuten.de','zehnminutenmail.de','zippymail.info',
  // ── French disposable ────────────────────────────────────────────────────
  'courriel.fr.nf','courrieltemporaire.com','cool.fr.nf',
  // ── Misc ─────────────────────────────────────────────────────────────────
  'crapmail.org','dacoolest.com','dandikmail.com','dayrep.com',
  'deadaddress.com','deadletter.ga','dingbone.com',
  'disposableaddress.com','disposableinbox.com','dispose.it','domozmail.com',
  'drdrb.com','drdrb.net','crazymailing.com',
  'disposeamail.com','discard.email',
  'rcpt.at','reallymymail.com','reconmail.com','recyclemail.dk',
  'sandelf.de','saynotospams.com','skeefmail.com','slushmail.com',
  'smashmail.de','sneakemail.com','sneakmail.de','snkmail.com',
  'sogetthis.com','supergreatmail.com','suremail.info',
  'tempr.email','tempski.com','thanksnospam.info',
  'thisisnotmyrealemail.com','thismail.net','tilien.com','tmailinator.com',
  'tradermail.info','trashdevil.com','trashdevil.de','trashemail.de',
  'trashimail.com','trayna.com','trmailbox.com','tsiok.com',
  'uggsrock.com','veryrealemail.com','viditag.com','walkmail.net','walkmail.ru',
  'wetrainbayarea.com','wetrainbayarea.org',
  'xcodes.net','yodx.ro','yogamaven.com',
  'ypmail.webarnak.fr.eu.org','yuurok.com','za.com',
  'photosynthesis.life',
]);

// ─── Role-Based Local-Parts ───────────────────────────────────────────────────
// Generic function aliases that belong to a team/system, not an individual.
const ROLE_BASED_PREFIXES = new Set<string>([
  'abuse','account','accounts','admin','administrator','all',
  'billing','bounce','bounces','career','careers',
  'ceo','cfo','cmo','coo','cto','contact',
  'daemon','demo','dev','developers','devops',
  'dns','do-not-reply','do_not_reply','donotreply',
  'email','enquiries','enquiry','errors',
  'fax','feedback','finance','fraud','ftp',
  'general','government','hello','help','helpdesk','hi','hosting','hostmaster','hr',
  'info','it','jira','jobs','legal',
  'list','lists','log','logger','logging',
  'mail','mailer','mailer-daemon','maintenance','marketing',
  'me','media','moderator','monitor','monitoring',
  'newsletter','no-reply','noc','noreply','notifications',
  'null','office','ops','operations','outreach',
  'partners','postmaster','pr','press','privacy','public',
  'qa','recruitment','relay','reply','reports','root',
  'sales','security','server','service','services',
  'shop','soc','social','spam','staff','subscribe',
  'subscriptions','support','sys','sysadmin','systems',
  'team','tech','test','testing','tos','unsubscribe',
  'user','users','uucp','vpn','webmaster','www',
]);

// ─── Public API ───────────────────────────────────────────────────────────────

export interface DisposableCheckResult {
  isDisposable: boolean;
  isRoleBased:  boolean;
}

/**
 * Checks whether an email belongs to a disposable provider and/or uses a
 * generic role-based local-part.
 *
 * Handles sub-addressing (user+tag@domain → base local "user").
 */
export function checkDisposableAndRole(email: string): DisposableCheckResult {
  const atIdx    = email.lastIndexOf('@');
  const domain   = atIdx >= 0 ? email.slice(atIdx + 1).toLowerCase() : '';
  const local    = atIdx >= 0 ? email.slice(0, atIdx).toLowerCase()  : email;
  const baseLocal = local.split('+')[0].trim();

  return {
    isDisposable: DISPOSABLE_DOMAINS.has(domain),
    isRoleBased:  ROLE_BASED_PREFIXES.has(baseLocal),
  };
}
