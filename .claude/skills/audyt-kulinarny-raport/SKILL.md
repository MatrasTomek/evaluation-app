---
name: audyt-kulinarny-raport
description: Use when the user sends photos of a dish plus a text description or an audio recording (notatka głosowa) from a restaurant visit and wants a PDF report – raport z audytu kulinarnego, audyt dania/produktu, ocena sensoryczna, food cost, rekomendacje szefa kuchni, raport MP Consulting Food, "zrób raport jak Panuozzo".
---

# Raport z audytu kulinarnego (PDF)

Ze zdjęć dania i opisu audytora (tekst albo nagranie) powstaje `raport.json`, a z niego skrypt składa
PDF w układzie slajdów A4 poziomo – ten sam wygląd co raport wzorcowy w `przyklad/`.

**Zasada nadrzędna:** raport trafia do właściciela lokalu jako ekspertyza. Każde zdanie ma mieć źródło:
zdjęcie, słowa audytora albo obliczenie. To, co szacujesz, oznacz jako szacunek.

## Przebieg

1. **Zbierz wejście.**
   - Zdjęcia: obejrzyj każde narzędziem Read. Format JPG/PNG/WEBP (HEIC poproś o eksport do JPG).
   - Opis: tekst z wiadomości. Jeśli jest plik audio (m4a, mp3, ogg, opus, wav, mp4) – najpierw skill
     `transkrypcja-audio`, dalej pracuj na transkrypcji.
2. **Wypisz fakty ze źródłem** (roboczo, w odpowiedzi – nie do pliku): danie, lokal, data wizyty, cena,
   skład i gramatury deklarowane, waga z menu, technologia, wrażenia audytora, co widać na zdjęciach.
3. **Uzupełnij braki** według tabeli „Braki w danych”. O cenę w menu i datę wizyty zapytaj raz, jednym
   pytaniem (AskUserQuestion), jeśli ich nie ma – bez ceny nie istnieje część finansowa.
4. **Policz liczby skryptem** (`node -e`), nie w pamięci – wzory w sekcji „Obliczenia”.
5. **Napisz `raport.json`** w katalogu `raporty/<RRRR-MM-DD>-<danie>/`, zdjęcia skopiuj obok do `foto/`.
   Wzoruj się na `przyklad/raport.json` (pełne 15 slajdów) – skopiuj go i podmień treść.
6. **Wyrenderuj:**
   ```bash
   node .claude/skills/audyt-kulinarny-raport/scripts/render.mjs raporty/<katalog>/raport.json \
     raporty/<katalog>/Audyt_<Danie>_<Marka>.pdf --podglad raporty/<katalog>/podglad
   ```
   Kod wyjścia 2 = na wymienionych slajdach treść się nie mieści albo zdjęcie zostało ściśnięte: skróć
   tekst lub rozbij slajd na dwa i renderuj ponownie, aż będzie 0.
7. **Obejrzyj wynik** (Read na PNG z `podglad/`): okładkę, każdy slajd ze zdjęciem i slajd z najdłuższą
   tabelą. Sprawdź kadr zdjęć (`position`, np. `"center 70%"`) i czy nic nie jest ucięte.
8. **Oddaj:** ścieżka do PDF + krótka lista „do potwierdzenia przez klienta” (wszystkie szacunki i założenia).

## Braki w danych

| Brakuje | Co zrobić |
|---|---|
| Cena w menu, data wizyty | Zapytaj użytkownika (raz). |
| Receptura / gramatury deklarowane | Oszacuj ze zdjęć i opisu, każdą wartość poprzedź „ok.”, slajd zatytułuj „stan zaobserwowany”; pomiń slajd zgodności z recepturą i bilans gramatury. |
| Ceny surowców | Średnie hurtowe rynku polskiego z własnej wiedzy, zawsze „ok. X zł/kg” i podtytuł „do weryfikacji fakturami klienta”. Faktury od użytkownika mają pierwszeństwo. |
| Wrażenia smakowe (smak, temperatura, tekstura w ustach) | Tylko ze słów audytora. Zdjęcie nie mówi nic o smaku – kryterium bez danych usuń z tabeli ocen i przelicz wagi do 100%. |
| Nazwa lokalu | Nie jest wymagana – wzorzec jej nie podaje. |
| Zdjęcie przekroju / tylko jedno zdjęcie | Użyj tego samego zdjęcia z innym kadrem (`position`); nie opisuj tego, czego na nim nie widać. |

## Struktura raportu (wzorzec)

| # | Sekcja | Slajd | Kiedy pominąć |
|---|---|---|---|
| 1 | – | Okładka: danie, główne składniki, 5 punktów zakresu, data i forma wizyty | nigdy |
| 2 | 01 · Wprowadzenie | Zakres i metodologia + skala ocen 1–5 | nigdy |
| 3 | 01 · Wprowadzenie | Podsumowanie dla zarządu: 4 kafle KPI, 4–5 wniosków, rekomendacja główna | nigdy |
| 4 | 02 · Stan obecny | Karta produktu – stan deklarowany (skład, waga, cena, technologia) | nigdy (ew. „zaobserwowany”) |
| 5 | 03 · Ocena produktu | Ocena sensoryczna – tabela ważona | nigdy |
| 6 | 03 · Ocena produktu | Weryfikacja wizualna: niezgodności / obserwacje / zgodne | brak receptury → zostaw same obserwacje |
| 7 | 03 · Ocena produktu | Analiza technologiczna: stan obecny vs standard docelowy + komentarz szefa kuchni | – |
| 8 | 04 · Finanse | Food cost – receptura deklarowana | brak ceny |
| 9 | 04 · Finanse | Food cost rzeczywisty + bilans gramatury | brak receptury lub wagi z menu |
| 10 | 05 · Rekomendacje | 6 kart „smaczków” – konkretne techniki z parametrami (czas, temperatura, proporcje) | – |
| 11 | 05 · Rekomendacje | Receptura 2.0 z kalkulacją i rekomendacją cenową | brak ceny → sama receptura |
| 12 | 06 · Wdrożenie | Standardy operacyjne + HACCP dla rekomendowanych składników | – |
| 13 | 06 · Wdrożenie | Sprzedaż: opis do menu, upsell, pairing | – |
| 14 | 06 · Wdrożenie | Plan działań: priorytet, działanie, odpowiedzialny, termin, efekt | nigdy |
| 15 | – | Podsumowanie, następny krok, zastrzeżenie o źródłach danych | nigdy |

Po usunięciu slajdu popraw odwołania typu „(slajd 13)”.

**Kryteria oceny** (wagi wzorca, razem 100%): prezentacja 15, obróbka termiczna/wypiek 15, tekstura i
proporcje 15, białko – jakość i ilość 15, balans smaku 15, sos 10, świeżość dodatków 10, zgodność z
recepturą 5. Nazwy dopasuj do dania (zupa nie ma „wypieku”), wagi mają dać 100%.

## Obliczenia

- Ocena ważona = Σ(waga × ocena), 1 miejsce po przecinku; procent = ocena / 5.
- Koszt składnika = ilość × cena hurtowa (dla mięsa licz masę surową, podaj ją w nawiasie), zaokrąglaj do 0,05 zł.
- Food cost = suma surowców × 1,05 (bufor strat 5%).
- Cena netto = brutto / 1,08 (gastronomia, VAT 8%; napoje, kawa, alkohol: 23%).
- Food cost % = food cost / cena netto. Marża na surowcu = netto − food cost. Mnożnik = netto / food cost.
- Benchmark food costu dla dań: 25–32%.
- Waga po obróbce: ciasto traci 10–15% masy, mięso 25–30%.
- Te same liczby powtarzają się na slajdach 3, 8, 9, 11 i 15 – po każdej zmianie sprawdź wszystkie.

## Format `raport.json`

Góra pliku: `brand` (domyślnie `MP CONSULTING FOOD`), `footer`
(`MP Consulting Food · Raport z audytu kulinarnego · DD.MM.RRRR · materiał poufny`), `slides`.

Slajdy: `"type": "cover"` (`kicker`, `title`, `subtitle`, `bullets`, `meta`, `image`),
`"type": "closing"` (`title`, `text`, `next`, `disclaimer`, `image`), a bez `type` – slajd treści:
`title`, `section`, `subtitle` oraz bloki w `top`, `blocks`, `columns: [{width, blocks}]`, `bottom`.

| Blok | Pola |
|---|---|
| `text` | `heading?`, `text`, `size: "large"?` |
| `bullets` | `heading?`, `items`, `tone?` |
| `table` | `heading?`, `columns: [{label, width?, align?, kind?}]`, `rows`; `kind`: `score` (kolor wg 1–5), `priority` (WYSOKI/ŚREDNI/NISKI), `bold`, `small`; wiersz jako tablica albo `{style: "sum"\|"strong"\|"accent", cells}`; komórka jako tekst albo `{text, tone}` |
| `kpis` | `items: [{label, value, note?, tone?}]`, `columns?` |
| `image` / `images` | `src`, `caption?`, `position?` / `items: [...]` |
| `cards` | `items: [{title, text}]`, `columns?` – numerowane 01, 02… |
| `callout` | `text` – ciemna ramka na rekomendację główną |
| `box` | `heading?`, `text`, `note?` – beżowa ramka (opis do menu) |
| `spacer` | wypycha kolejne bloki na dół kolumny |

`tone`: `good` (zielony), `warn` (bursztyn), `bad` (czerwony), `accent`. W tekstach działa `**pogrubienie**`.
Ścieżki zdjęć są względne wobec pliku JSON.

**Objętość, która mieści się na slajdzie:** karta ≤ 330 znaków; obserwacja w tabeli ocen ≤ 140 znaków;
tabela ≤ 11 wierszy; kolumna z nagłówkami ≤ 5 punktów na listę; wniosek w podsumowaniu ≤ 220 znaków.

## Styl treści

- Język klienta: konkret, liczby, skutek dla gościa i dla marży. Każdy zarzut ma parę: co poprawić i ile to kosztuje.
- Wnioski zaczynaj pogrubioną tezą: `**Brakuje kwasowości.** Deklarowany pikiel nie trafia na talerz…`.
- Rekomendacje to techniki z parametrami („180°C, 12–15 min”, „zalewa 3:2:1”), nie ogólniki („poprawić smak”).
- Zawsze wskaż mocne strony – raport ma być do wdrożenia, nie do obrony.
- Polska typografia: cudzysłowy „ ”, półpauza –, przecinek dziesiętny, `59,00 zł`, `15,4 %`.

## Częste błędy

| Błąd | Poprawnie |
|---|---|
| Ocena smaku wywnioskowana ze zdjęcia | Smak tylko z opisu audytora; ze zdjęcia: wygląd, proporcje, składniki, wypiek. |
| Gramatury i ceny podane jak pomiar | „ok.”, „wizualnie ok. 60–70 g”, „do weryfikacji fakturami”. |
| Suma w tabeli nie zgadza się z wierszami | Licz skryptem, potem przepisz. |
| Renderer zwrócił 2, a PDF oddany | Skróć treść i renderuj do kodu 0. |
| Zmyślona nazwa lokalu, kucharza, daty | Brak danych = pytanie albo pominięcie pola. |
| Zdjęcie z twarzą osoby postronnej w kadrze | Przesuń kadr (`position`) na talerz albo wybierz inne zdjęcie. |
