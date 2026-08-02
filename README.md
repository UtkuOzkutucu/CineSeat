# CineSeat

Paribu Cineverse için masaüstü uygulaması. Salon → film → seans gezinir, seçtiğiniz
seansın koltuk planını canlı okur ve **kaç kişiyseniz o kadar yan yana, salonun tatlı
noktasındaki** koltukları önerir: *"I sırası, koltuk 7-8 · %100"*.

Salt okunur. Giriş yok, ödeme yok, rezervasyon yok. "Bilet al" düğmesi sizi sitenin
kendi sayfasına gönderir.

---

## Kurulum

`BUILD-APP.bat` dosyasına **bir kez** çift tıklayın. Bağımlılıkları kurar ve
`dist\CineSeat-Setup-3.0.0.exe` üretir. O kurulumu çalıştırdıktan sonra uygulama
Başlat menüsünde ve masaüstünde normal bir program gibi durur — bir daha `.bat`
çalıştırmanız gerekmez.

Terminalden:

```bash
npm install && npm run dist
```

Geliştirirken pencereyi doğrudan açmak için:

```bash
npm run app
```

Yalnızca sunucuyu çalıştırıp tarayıcıdan bakmak için:

```bash
npm start
```

Gereken tek şey Node.js 18 veya üzeri. Yerel derleme (native module) yok, veritabanı
sunucusu yok, Docker yok.

---

## Nasıl çalışır

Uygulama, sitenin kendi bilet sayfasının kullandığı uç noktalara gider. Her panel tek
bir istek ve hepsi 100 ms'nin altında; bu yüzden arka planda tarama yapan bir crawler
veya yerel katalog veritabanı **yok** — gördüğünüz her şey o anda canlı.

| Uç nokta | Döndürdüğü |
|---|---|
| `POST /Cinema/GetCinemaListsByFilter` | 77 salon: `VistaCinemaId`, şehir, teknolojiler, konum, mesafe |
| `POST /Film/GetAllowedSalesFilmsByFilter` | Vizyondaki filmler |
| `POST /Film/GetFilmSessionDatesView` | O film + salon için bilet açık tarihler |
| `POST /Film/GetFilmSessionsView` | Seanslar, sitenin kendi grupladığı gibi |

İki yönlü çalışır: `CinemaIds` gönderirseniz o salonun filmlerini, `ScheduledFilmIds`
gönderirseniz o filmi oynatan salonları verir. Paneller arasındaki **⇅** düğmesi
bundan ibaret.

### Koltuk planı dört adım

Pahalı olan tek kısım bu, çünkü sunucu tarafında geçici bir sepet oluşturur.

1. `GET /biletleme/~step~ticket~code~{kod}~session~{id}` → `UserSessionId` + bilet tipleri
2. `POST /Ticketing/AddTicketWithConcession` → `{"Result":0}`
3. `POST /Ticketing/BookingSeat` → `<table id="seatContainer">`

**2. adım atlanamaz.** Atlanırsa `BookingSeat` HTTP 200 döner ama gövdesi 8 bayttır ve
koltuk planı hiç gelmez. Projenin ilk sürümünde bütün koltuk planlarının boş çıkmasının
sebebi tam olarak buydu: `res.ok` doğru olduğu için başarı sayılıyor, boş sonuç
önbelleğe yazılıyor, arayüz de bunu "yer yok" diye gösteriyordu. Artık boş gövde hata
sayılır.

Hız için `POST /Ticketing/AssignNewUserSessionId` kullanılır: 56 KB'lık sayfa yerine
59 baytta taze token üretir ve başka bir seans için de geçerlidir. Bilet tipleri
bilinmiyorsa veya token reddedilirse otomatik olarak tam sayfaya düşer.

---

## Sabit değer yok

Siteye ait hiçbir değer koda gömülü değildir. Altı ilde yapılan ölçüm nedenini
gösteriyor:

| Şehir | Bilet kodları | Fiyatlar | Koltuk kategorisi |
|---|---|---|---|
| Bolu | `0231` / `0235` | ₺295 / ₺270 | `0000000001` |
| Çanakkale | `0247` / `0249` | ₺260 / ₺260 | `0000000001` |
| Kocaeli | `0002` / `0006` | ₺355 / ₺330 | `0000000001` |
| İstanbul Avrupa | `1250` / `1310` | ₺735 / ₺685 | `0000000010` |
| İstanbul Anadolu | `1058` / `1098` | ₺795 / ₺750 | `0000000012` |
| Ankara | `0002` / `0006` | ₺400 / ₺370 | `0000000001` |

Aynı `0002` kodu Kocaeli'de ₺355, Ankara'da ₺400 — yani fiyat koddan türetilemez. Gold
Class salonları `0000000001` kategorisini kullanmıyor. Bunlar her seans için yeniden
okunur.

Şehir de tahmin edilmez: her salonun `SiteGroupId` değeri sitenin kendi şehir listesiyle
eşlenir. 77 salonun 77'sinde şehir ve koordinat doğru gelir.

---

## Gece seansları

Bir salon 01:30 seansını 2 Ağustos altında listeler ama o seans aslında 3 Ağustos'a
aittir. Site bunu kendisi işaretler:

```html
<div id="showtime-20260803013000"
     data-warning="Seçtiğin seans 2.08.2026 tarihini 3.08.2026 tarihine bağlayan geceye aittir.">
  01:30
</div>
```

Öğe kimliği gerçek tarihi taşır, `data-warning` de Türkçe açıklamayı. Uygulama listede
**+1 gün** rozeti gösterir; seansa tıkladığınızda sitenin kendi metnini içeren uyarı
çıkar ve **Tamam**'a basmadan koltuk planı açılmaz.

---

## Hız ve nezaket

İstekler iki kulvara ayrılır:

- **Etkileşimli** (beklediğiniz işler): aynı anda 6, aralarında ~200 ms
- **Arka plan** (yalnızca takip listesi yenilemesi): aynı anda 1, aralarında 1,2 sn

Bir film + salon + tarih için **bütün** seanslar taranır, üst sınır yok. Ölçülen: 23
seans **6,1 saniye**, önbellek sıcakken 0,4 saniye.

**Emniyet freni:** site `429`/`403` dönerse veya üst üste üç istek başarısız olursa
etkileşimli kulvar 15 dakikalığına yavaş kulvarın hızına iner, Durum sekmesinde bunu
söyler ve kendiliğinden toparlar.

Otomatik tarama Durum sekmesinden kapatılabilir; kapalıyken koltuklar yalnızca bir
seansa tıklayınca alınır.

---

## Koltuk seçimi

Salonlar 7×9'dan 15×39'a kadar değişiyor (55 ile 456 koltuk arası, 8 kat fark), bu
yüzden algoritma salon boyutuna göre ölçeklenir:

- Derinlik yalnızca **koltuklu** sıralar üzerinden hesaplanır; her salonda `data-r`'nin
  atladığı bir ara koridor sırası var
- Kenar cezası sıra genişliğine göredir; yoksa 7 koltukluk bir sırada her koltuk
  "kenar" sayılır
- Sığ salonlarda Gauss eğrisi genişletilir
- Farklı salonların skorları karşılaştırılmadan önce salon içinde normalize edilir
- Yalnızca `data-allowed-cc` ile eşleşen koltuklar aday olur — Gold Class biletiyle
  standart koltuk seçilemez

Sıra 0 salonun **arkasıdır**; harfler perdeye doğru azalır (G→A, O→A, K→A ile doğrulandı).

---

## Proje yapısı

```
electron/main.js           Masaüstü penceresi; Express'i kendi içinde başlatır
src/config.js              Tek ayar dosyası (yalnızca kendi politikamız)
src/net/client.js          İki kulvarlı istemci, zaman aşımı, yeniden deneme, emniyet freni
src/net/cineverse.js       Dört katalog uç noktası + koltuk akışı
src/parse/sessions.js      Seans parçası → teknoloji, format, gece seansı
src/parse/seatmap.js       #seatContainer → ızgara
src/parse/ticket.js        Token + bilet tipleri (satışta olmayanı ayırt eder)
src/algo/seatDetection.js  Salon boyutuna duyarlı sıralama
src/seats.js               Önbellek, ucuz token, paralel tarama
src/store.js               Küçük JSON dosyası: favoriler, takip, ayarlar
src/api/routes.js          HTTP arayüzü
public/                    Üç panelli arayüz
tools/make-icon.js         build/icon.ico üretir
```

Ayarlar ve takip listesi tek bir JSON dosyasında tutulur (yolu Durum sekmesinde yazar).
Veritabanı yok — bu sayede yerel derleme gerektiren bir bağımlılık da yok.

---

## Testler

```bash
npm test
```

50 test. Koltuk planı fixture'ları üç ayrı salon boyutundan alınmıştır (71 / 125 / 256
koltuk) çünkü algoritma başlangıçta tek bir 256 koltukluk salona göre ayarlanmıştı ve o
salon temsili değildi.

Site değişirse fixture'ları yenileyin:

```bash
npm run capture:fixtures
```

Parser'lar boş sonuç döndürmek yerine **hata fırlatır**. İlk sürümün asıl kusuru sessiz
başarısızlıktı; testler bunun tekrarını yakalamak için var.

---

## Sınırlar

- Uç noktalar, sitenin kendi arayüzünün kullandığı belgelenmemiş uç noktalardır. Haber
  verilmeden değişebilirler; o zaman testler kırmızıya döner.
- Koltuk planı istemek sunucu tarafında geçici bir sepet oluşturur. Giriş, ödeme veya
  koltuk kilidi yoktur; herhangi bir ziyaretçinin "devam et" tıklamasıyla aynı şey. Yine
  de otomatik tarama açıkken bu, gezindiğiniz her seans için tekrarlanır.
- Bilet fiyatları gösterilir ama uygulama satın alma sürecine hiç girmez.
