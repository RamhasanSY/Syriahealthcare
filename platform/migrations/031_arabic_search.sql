-- Search that forgives Arabic spelling variants (docs/STUFE-3.md, 3f): "احمد" finds "أحمد", "مشفى" finds "مشفي",
-- "فاطمه" finds "فاطمة". Both the text and the search words are folded the same way:
--   lower case; short vowels, shadda and sukun (U+064B to U+0652), superscript alef (U+0670) and tatweel (U+0640) removed;
--   أ إ آ ٱ -> ا, ة -> ه, ى -> ي, ؤ -> و, ئ -> ي.
-- The marks are given by their code points: written out, combining marks in a pattern are easy to get wrong.
CREATE FUNCTION shc_fold(t text) RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT translate(lower(regexp_replace(coalesce(t, ''), '[' || chr(1611) || '-' || chr(1618) || chr(1648) || chr(1600) || ']', '', 'g')),
                     'أإآٱةىؤئ', 'ااااهيوي')
$$;
