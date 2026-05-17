# 🎵 Music Pitch Changer

Chrome-расширение для изменения тональности (pitch) и скорости (speed) аудио в реальном времени с анализом BPM и тональности.

## Возможности

- **Изменение тональности** (±12 полутонов) с сохранением темпа
- **Изменение скорости** (0.5x–2x) с сохранением тональности
- **Независимое управление** pitch и speed
- **BPM детектор** — автоматическое определение темпа в реальном времени
- **Key детектор** — определение тональности (C major, A minor и т.д.) с указанием уверенности
- **Bypass-режим** — прослушивание исходного аудио без обработки
- **100% обработка на устройстве** — ничего не отправляется на сервер

## Архитектура

Расширение построено на **Manifest V3** с использованием современной архитектуры:

```
Popup (React UI) ↔ Service Worker (координация) ↔ Offscreen Document (аудио-движок)
```

### Компоненты

| Компонент              | Файл                                                                   | Назначение                                                          |
| ---------------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Popup**              | [`src/popup/`](src/popup/)                                             | React UI с компонентами управления                                  |
| **Service Worker**     | [`src/background/service-worker.ts`](src/background/service-worker.ts) | Координация сообщений, управление offscreen документом, keep-alive  |
| **Offscreen Document** | [`src/offscreen/offscreen.ts`](src/offscreen/offscreen.ts)             | Точка входа для AudioContext (требование Chrome V3)                 |
| **Audio Engine**       | [`src/offscreen/audio-engine.ts`](src/offscreen/audio-engine.ts)       | Построение графа AudioNode, управление Worklet'ами                  |
| **PitchProcessor**     | [`src/worklets/pitch-processor.ts`](src/worklets/pitch-processor.ts)   | AudioWorklet для изменения pitch/speed (линейная интерполяция)      |
| **BPMProcessor**       | [`src/worklets/bpm-processor.ts`](src/worklets/bpm-processor.ts)       | AudioWorklet для определения BPM (автокорреляция)                   |
| **KeyProcessor**       | [`src/worklets/key-processor.ts`](src/worklets/key-processor.ts)       | AudioWorklet для определения тональности (хромаграмма + корреляция) |

### Поток данных

1. Пользователь нажимает "Start" в Popup
2. Popup отправляет `START_CAPTURE` сообщение в Service Worker
3. Service Worker создаёт Offscreen Document, получает `MediaStreamId` через `tabCapture.getMediaStreamId()`
4. Offscreen Document инициализирует AudioContext, загружает AudioWorklet'ы, строит аудио-граф
5. Worklet'ы анализируют аудио и отправляют метрики (BPM, тональность) обратно
6. Popup отображает метрики в реальном времени
7. Пользователь управляет pitch/speed через слайдеры — параметры передаются в Worklet

## Технологии

- **React 18** — UI компоненты
- **TypeScript 5.6** — типизация
- **Vite 6** — сборка
- **Tailwind CSS 3** — стилизация
- **Vitest** — unit-тесты (43 теста)
- **AudioWorklet** — низколатентная обработка аудио
- **Chrome Extension Manifest V3**

## Установка и запуск

```bash
# Клонирование
git clone https://github.com/vrd096/music-pitch-changer.git
cd music-pitch-changer

# Установка зависимостей
npm install

# Полная сборка (расширение + worklet'ы)
npm run build:all

# Или по отдельности:
npm run build:worklets   # сборка AudioWorklet'ов (IIFE)
npm run build            # сборка расширения

# Запуск тестов
npm test

# Проверка типов
npm run lint
```

### Загрузка в Chrome

1. Открой [`chrome://extensions/`](chrome://extensions/)
2. Включи **"Режим разработчика"** (правый верхний угол)
3. Нажми **"Загрузить распакованное расширение"**
4. Выбери папку [`dist/`](dist/) в корне проекта

После загрузки расширение появится в панели инструментов Chrome. Открой любую вкладку с аудио (YouTube, Beatport и т.д.) и нажми **Start**.

## Разработка

```bash
# Режим наблюдения
npm run dev

# Тесты в режиме наблюдения
npm run test:watch
```

## Тестирование

Проект покрыт **43 unit-тестами**:

- [`tests/types.test.ts`](tests/types.test.ts) — 13 тестов: проверка констант, типов, структуры данных
- [`tests/messaging.test.ts`](tests/messaging.test.ts) — 12 тестов: фабрика сообщений, отправка, storage
- [`tests/components.test.tsx`](tests/components.test.tsx) — 18 тестов: рендер компонентов, обработка событий

## Структура проекта

```
src/
├── popup.html                 # Popup HTML (точка входа)
├── offscreen.html             # Offscreen HTML (точка входа)
├── manifest.json              # Манифест расширения
├── audio-worklet.d.ts         # Типы для AudioWorklet
├── background/
│   └── service-worker.ts      # Service Worker
├── offscreen/
│   ├── audio-engine.ts        # Аудио-движок
│   └── offscreen.ts           # Точка входа Offscreen
├── popup/
│   ├── components/
│   │   ├── BpmDisplay.tsx     # Отображение BPM
│   │   ├── BypassToggle.tsx   # Bypass переключатель
│   │   ├── KeyDisplay.tsx     # Отображение тональности
│   │   ├── PitchSlider.tsx    # Слайдер тональности
│   │   ├── SpeedSlider.tsx    # Слайдер скорости
│   │   └── StartStopButton.tsx
│   ├── hooks/
│   │   └── useExtensionState.ts
│   ├── App.tsx
│   ├── index.css
│   └── index.tsx
├── shared/
│   ├── messaging.ts           # Фабрика сообщений
│   └── types.ts               # Общие типы
├── worklets/
│   ├── bpm-processor.ts       # BPM AudioWorklet
│   ├── key-processor.ts       # Key AudioWorklet
│   └── pitch-processor.ts     # Pitch AudioWorklet

dist/                          # Сборка (загружается в Chrome)
├── manifest.json
├── popup.html
├── offscreen.html
├── background/
│   └── service-worker.js
├── offscreen/
│   └── offscreen.js
├── assets/
│   ├── popup-*.css
│   ├── popup-*.js
│   └── ...
├── worklets/                  # AudioWorklet IIFE файлы
│   ├── pitch-processor.js
│   ├── bpm-processor.js
│   └── key-processor.js
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## Лицензия

MIT
