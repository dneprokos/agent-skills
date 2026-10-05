# План доповнення презентації «ISTQB CTAL-TAE»

Джерела аналізу:

- `docs/[Hot_ISTQB_Conf]_Presentation_Kostiantyn Teltov.pptx` (48 слайдів, слайди 10–36 — глави Syllabus)
- Стаття [My ISTQB Odyssey: Nine Years from Foundation to Automation](https://medium.com/@dneprokos/my-istqb-odyssey-nine-years-from-foundation-to-automation-219598e26943), розділ **🧭 ACT II: The Journey**

---

## 1. Поточний стан слайдів по главах

| Глава | Слайди | Змістовні (deep-dive) слайди | Слайди з питаннями екзамену |
|---|---|---|---|
| Ch1 — Introduction and objectives | 10–11 | **0** | 1 |
| Ch2 — Preparing for test automation | 12–13 | **0** | 1 |
| Ch3 — Test Automation Architecture | 14–22 | **5** (gTAA, TAF Layers, Scaling, Approaches, Design Patterns) | 3 |
| Ch4 — Implementing Test Automation | 23–25 | **0** | 2 |
| Ch5 — Implementation and Deployment Strategies | 26–27 | **0** | 1 |
| Ch6 — Reporting and Metrics | 28–30 | **0** | 2 |
| Ch7 — Verifying the TA Solution | 31–33 | **0** | 2 |
| Ch8 — Continuous Improvement | 34–36 | **0** | 2 |

**Висновок:** глава 3 має слайд «Про що глава» + 5 візуальних слайдів. Усі інші глави — лише один текстовий слайд + слайди з питаннями. Стаття дає сильний матеріал для всіх 8 сцен, але 6 із них не мають жодного візуального слайда.

---

## 2. Рекомендація: +7 слайдів, два пріоритети

Баланс зберігається: Ch3 залишає 5 змістовних слайдів, інші глави отримують по одному. Глава 3 і далі виглядає найбільшою — це навмисна асиметрія.

| # | Новий слайд | Ставити після слайда | Пріоритет |
|---|---|---|---|
| A | Ch1 — Переваги / Недоліки / Обмеження | **10** | ОБОВ'ЯЗКОВО |
| B | Ch2 — Testability = Observability + Controllability | **12** | ОБОВ'ЯЗКОВО |
| C | Ch5 — Рівні тестів у CI/CD pipeline | **26** | ОБОВ'ЯЗКОВО |
| D | Ch6 — Чому впав тест? (тріаж) | **28** | ОБОВ'ЯЗКОВО |
| E | Ch4 — Пілот vs Ризики деплойменту | **23** | ЖЕЛАНО |
| F | Ch7 — Automation code — теж продукт | **31** | ЖЕЛАНО |
| G | Ch8 — Безпечне оновлення залежностей | **34** | ЖЕЛАНО |

Правила:

- Якщо доповідь коротша за 30 хвилин — залишити тільки блок «ОБОВ'ЯЗКОВО».
- Не додавати другий слайд на главу: це зруйнує акцент на главі 3.
- Разом: 48 → 55 слайдів, приблизно +6–8 хвилин мовлення.

---

## 3. Зміст слайдів

### A — після слайда 10 (Chapter 1)

**Заголовок:** `Chapter 1.2: Що автоматизація дає і чого не дасть ніколи`

Три колонки:

| ✅ Головна перевага | ❌ Головний недолік | ⚠️ Головне обмеження |
|---|---|---|
| Тести, які **неможливо** виконати вручну: real-time response, remote testing, parallel testing | Потребує **початкових інвестицій** на побудову Test Automation Solution | Перевіряє лише **machine-interpretable results** |

Підпис унизу:

> Exploratory та UX — досі люди. Автоматизація не замінює судження.

**Навіщо:** на слайді 10 теза «Не всі тести варто автоматизувати» подана лише буллетом. Цей слайд її доводить і задає «навіщо» для всієї доповіді.

---

### B — після слайда 12 (Chapter 2)

**Заголовок:** `Chapter 2.1: Оцінка SUT — Testability`

Формула по центру:

```
Testability = Observability + Controllability
```

- **Observability** — чи можу я побачити стан системи? (логи, API, БД, події)
- **Controllability** — чи можу я привести систему в потрібний стан? (тестові дані, hooks, feature toggles)

Смуга внизу — сходинка середовищ:

```
Local Dev → Build → Integration → Preproduction → Production
```

Підпис: `для кожного середовища — свій набір тестів і свої дані`

Цитата в футері:

> «Не обирай молоток, поки не знаєш, що будуєш»

**Навіщо:** слайд 12 перелічує ці три терміни як ключові слова без жодного означення. Питання екзамену зі статті б'є саме в observability.

---

### C — після слайда 26 (Chapter 5)

**Заголовок:** `Chapter 5.1.1: Рівні тестів у Pipeline`

Горизонтальний pipeline, три стадії, під кожною — свої рівні тестів:

```
   BUILD          ──►   CONTINUOUS INTEGRATION   ──►   CONTINUOUS DELIVERY / DEPLOYMENT
      │                          │                                 │
 Configuration           Component tests                   System integration tests
    tests                Component integration                System tests
 (перевіряє сам             tests                          (фінальний quality gate)
  TAF/TAS build)        (quality gate)
```

Блок-виноска праворуч — **Configuration Management — це не лише код:**

- Test environment configuration (URLs, credentials)
- Test data
- Test suites / test cases (smoke, regression)
- Feature toggle configuration

**Навіщо:** найбільша візуальна прогалина в колоді. Слайд 26 запихає всі шість рівнів тестів в один довгий рядок тексту — з третього ряду залу це не читається. Це ж і тема слайда з питанням 27.

---

### D — після слайда 28 (Chapter 6)

**Заголовок:** `Chapter 6.2: Червоний тест ≠ баг`

Пронумерований потік із 5 кроків:

```
1. Чи падав раніше?          →  історія прогонів, тренд
2. Що саме перевіряє тест?   →  сценарій
3. На якому кроці впав?      →  test step
4. Які є докази?             →  логи TAS + логи SUT + screenshot + API response
5. Хто винен?                →  SUT bug | TAS bug | Environment
```

Смуга внизу — три бокси-вердикти: `Дефект SUT` / `Дефект TAS` / `Проблема середовища`

Бічна нотатка:

> Timestamp correlation між TAS logs і SUT logs скорочує root cause analysis у рази.

**Навіщо:** найсильніший практичний висновок Сцени 6 у статті, на слайдах не представлений узагалі. Також найбільш цитована ідея всього ACT II.

---

### E — після слайда 23 (Chapter 4)

**Заголовок:** `Chapter 4.1: Пілот — що вирішуємо, чим ризикуємо`

Дві колонки:

| 🎯 Пілотний проєкт: рішення | 💥 Ризики деплойменту |
|---|---|
| Мова(и) програмування | Firewall / доступи |
| Commercial vs open-source | CPU / RAM на агентах |
| Які рівні тестів покриваємо | Packaging + version control |
| Критерії відбору тест-кейсів | Рівні логування |
| Підхід до розробки | Автооновлення агентів і девайсів |

Підпис унизу:

> Інфраструктурний ризик — це не дефект застосунку.

---

### F — після слайда 31 (Chapter 7)

**Заголовок:** `Chapter 7.3: Твій automation code — теж продукт`

Ліворуч — **Static analysis шукає:**

- hardcoded credentials
- security issues
- неефективний код
- погані практики

Праворуч — **Тихі вбивці довіри:**

- **відсутній assertion** → тест зелений завжди
- **tool intrusiveness** → інструмент змінює поведінку SUT
- різні версії TAS на різних середовищах
- нерепітабельні setup / teardown

Підпис унизу:

> Ті самі стандарти якості, що й для коду продукту.

---

### G — після слайда 34 (Chapter 8)

**Заголовок:** `Chapter 8.2: Безпечне оновлення TAS`

Потік із 4 кроків (саме такий порядок перевіряє питання екзамену):

```
Pilot  →  Determine impact  →  Adoption plan  →  Update dependencies
```

Праворуч — **Smarter automation:**

- Self-healing locators
- Schema validation (API / БД)
- **Test histogram** → flaky та fragile tests
- Fixed `sleep` → dynamic / event-based waits

---

## 4. Опційний бонус

**Карта Syllabus — після слайда 9 «Глави Syllabus».** Вісім плиток глав із кількістю Learning Objectives та часткою балів на екзамені. Дає залу прогрес-бар на наступні 25 слайдів. Дешево у виконанні, добре орієнтує — але це перший кандидат на виріз, якщо не вистачає часу.
