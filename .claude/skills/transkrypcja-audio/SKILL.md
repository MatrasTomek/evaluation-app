---
name: transkrypcja-audio
description: Use when the user provides an audio or video recording (notatka głosowa, nagranie, dyktafon, WhatsApp voice note – m4a, mp3, ogg, opus, wav, mp4, webm) whose spoken content is needed as text – transkrypcja, spisanie nagrania, opis podany głosem zamiast tekstu.
---

# Transkrypcja nagrania (lokalnie, Whisper)

Claude nie słyszy plików audio – treść nagrania trzeba najpierw zamienić na tekst. Skrypt robi to lokalnie
(nagranie nie opuszcza maszyny) i wypisuje transkrypcję ze znacznikami czasu.

```bash
node .claude/skills/transkrypcja-audio/scripts/transkrybuj.mjs sciezka/do/nagrania.m4a
```

Wynik: tekst na stdout oraz plik `<nagranie>.transkrypcja.txt` obok nagrania.

| Opcja | Znaczenie |
|---|---|
| `--jezyk polish` | Język nagrania (domyślnie polski); nazwa po angielsku: `english`, `italian`… |
| `--model turbo` | Domyślny, najdokładniejszy (whisper-large-v3-turbo, ok. 1,6 GB na dysku). |
| `--model small` / `base` | Szybsze i lżejsze, wyraźnie słabsze po polsku – tylko gdy brak miejsca lub czasu. |
| `--wynik plik.txt` | Inna ścieżka pliku wynikowego. |

## Pierwsze uruchomienie

- Skrypt sam pobiera do `./.cache/transkrypcja-audio/` bibliotekę, ffmpeg (jeśli nie ma go w systemie) i model.
  Potrzebna sieć: `registry.npmjs.org`, `github.com`, `*.githubusercontent.com`, `huggingface.co`, `*.hf.co`
  – w sandboxie podaj je w `allowed_domains`. Kolejne uruchomienia działają offline.
- Ustaw timeout polecenia na 600000 ms. Czas transkrypcji na CPU ≈ długość nagrania; nagrania powyżej
  ok. 8 minut uruchamiaj w tle (`run_in_background`).
- `.cache/` nie trafia do repozytorium (jest w `.gitignore`).

## Po transkrypcji

1. Przeczytaj całość, zanim cokolwiek z niej wykorzystasz.
2. Popraw oczywiste przesłyszenia nazw własnych i terminów branżowych, gdy kontekst jest jednoznaczny
   („panuco” → „panuozzo”, „skamorca” → „scamorza”).
3. Liczby – gramatury, ceny, daty, temperatury – przepisuj dokładnie tak, jak padły. Gdy liczba jest
   niewyraźna albo sprzeczna z resztą nagrania, zapytaj użytkownika zamiast zgadywać.
4. Nie dopisuj treści, której w nagraniu nie ma. Fragment niezrozumiały oznacz `[niewyraźne mm:ss]`.

## Gdy coś nie działa

| Objaw | Przyczyna i rozwiązanie |
|---|---|
| `EAI_AGAIN`, `fetch failed`, 407 | Brak dostępu do sieci przy pierwszym pobraniu – dodaj domeny z listy wyżej i uruchom ponownie. |
| „ffmpeg nie odczytał pliku” | Plik uszkodzony lub nie jest nagraniem; poproś o ponowne przesłanie. |
| Tekst w złym języku albo bełkot | Podaj właściwy `--jezyk`; przy cichym nagraniu z hałasem kuchni zostań przy `--model turbo`. |
| Powtarzające się w kółko zdanie | Halucynacja Whispera na ciszy – usuń powtórzenia, nie traktuj ich jako treści. |
