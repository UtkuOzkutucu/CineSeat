# CineSeat

Paribu Cineverse için geliştirilmiş masaüstü uygulaması. Salon → film → seans hiyerarşisinde gezinmenizi sağlar, seçtiğiniz seansın koltuk planını anlık olarak çeker ve **kaç kişiyseniz o kadar yan yana, salonun en ideal konumundaki** koltukları önerir: *"I sırası, koltuk 7-8 · %100"*.

Uygulama sadece bilgi amaçlıdır (read-only). Üyelik girişi, ödeme veya rezervasyon adımları içermez. "Bilet al" butonuna tıkladığınızda işlem yapabilmeniz için sizi doğrudan sinemanın kendi web sitesine yönlendirir.

---

## Kurulum

`BUILD-APP.bat` dosyasına **bir kez** çift tıklamanız yeterlidir. Bu dosya gerekli bağımlılıkları kurar ve `dist\CineSeat-Setup-3.0.0.exe` kurulum dosyasını oluşturur. Kurulumu tamamladıktan sonra uygulama, Başlat menüsünde ve masaüstünde normal bir program gibi yerini alır — bir daha `.bat` dosyasını çalıştırmanıza gerek kalmaz.

Terminal üzerinden kurmak için:

```bash
npm install && npm run dist
```

Geliştirme sürecinde uygulamayı doğrudan başlatmak için:

```bash
npm run app
```

Sadece sunucuyu ayağa kaldırıp tarayıcı üzerinden görüntülemek için:

```bash
npm start
```

Gereksinimler oldukça basittir: Yalnızca Node.js 18 veya üzeri bir sürüm yeterlidir. Yerel derleme (native module), veritabanı sunucusu veya Docker gerektirmez.

---

## Nasıl Çalışır?

Uygulama, doğrudan sitenin kendi biletleme sayfasındaki API uç noktalarını (endpoint) kullanır. Her bir panel tek bir API isteğiyle dolar ve yanıt süreleri genellikle 100 ms'nin altındadır. Bu nedenle arka planda sürekli tarama yapan bir web kazıyıcı (crawler) veya yerel bir veritabanı **yoktur** — ekranda gördüğünüz her veri anlıktır.

| Endpoint | Döndürdüğü Veri |
|---|---|
| `POST /Cinema/GetCinemaListsByFilter` | 77 adet salon: `VistaCinemaId`, şehir, teknolojiler, konum, mesafe |
| `POST /Film/GetAllowedSalesFilmsByFilter` | Vizyondaki filmler |
| `POST /Film/GetFilmSessionDatesView` | İlgili film ve salon için bilet satışına açık tarihler |
| `POST /Film/GetFilmSessionsView` | Sitenin kendi gruplandırmasına sadık kalınarak listelenen seanslar |

Sistem çift yönlü çalışır: `CinemaIds` gönderirseniz o salonun filmlerini, `ScheduledFilmIds` gönderirseniz o filmi oynatan salonları listeler. Paneller arasındaki **⇅** butonunun temel işlevi budur.

### Koltuk Planının Çekilmesi (4 Adım)

Sistemdeki en maliyetli işlem budur, çünkü sunucu tarafında geçici bir sepet oluşturulmasını gerektirir.

1. `GET /biletleme/~step~ticket~code~{kod}~session~{id}` → `UserSessionId` ve bilet tiplerini alır.
2. `POST /Ticketing/AddTicketWithConcession` → `{"Result":0}` döner.
3. `POST /Ticketing/BookingSeat` → Koltukları içeren `<table id="seatContainer">` yapısını getirir.

**2. adım kesinlikle atlanamaz.** Atlandığı takdirde `BookingSeat` isteği HTTP 200 (Başarılı) dönse bile gövdesi yalnızca 8 bayt olur ve koltuk planı gelmez. Projenin ilk sürümünde koltuk planlarının boş görünmesinin temel nedeni buydu: `res.ok` true döndüğü için işlem başarılı sanılıp önbelleğe boş sonuç yazılıyor, arayüz de bunu "yer yok" olarak yansıtıyordu. Yeni yapıda boş dönen gövde doğrudan hata olarak kabul ediliyor.

Performansı artırmak için `POST /Ticketing/AssignNewUserSessionId` endpoint'i kullanılır: 56 KB'lık sayfa yüklemek yerine 59 baytlık yeni bir token üretir ve bu token başka bir seans için de geçerli olur. Bilet tipleri bilinemiyorsa veya token reddedilirse sistem otomatik olarak tam sayfa akışına geri döner.

---

## Hardcoded (Sabit) Değerler Yok

Uygulamada siteye ait hiçbir yapılandırma doğrudan koda gömülmemiştir. Farklı illerden alınan aşağıdaki bilet ve fiyat örnekleri, bunun sebebini net bir şekilde açıklıyor:

| Şehir | Bilet Kodları | Fiyatlar | Koltuk Kategorisi |
|---|---|---|---|
| Bolu | `0231` / `0235` | ₺295 / ₺270 | `0000000001` |
| Çanakkale | `0247` / `0249` | ₺260 / ₺260 | `0000000001` |
| Kocaeli | `0002` / `0006` | ₺355 / ₺330 | `0000000001` |
| İstanbul Avrupa | `1250` / `1310` | ₺735 / ₺685 | `0000000010` |
| İstanbul Anadolu | `1058` / `1098` | ₺795 / ₺750 | `0000000012` |
| Ankara | `0002` / `0006` | ₺400 / ₺370 | `0000000001` |

Görüldüğü üzere aynı `0002` kodu Kocaeli'de ₺355 iken Ankara'da ₺400 olabiliyor; yani fiyat bilgisi sadece bilet koduna bakılarak türetilemez. Ayrıca Gold Class salonları standart `0000000001` kategorisini kullanmaz. Bu yüzden tüm bu veriler her seans için anlık olarak yeniden okunur.

Şehir eşleştirmeleri de tahmin üzerinden yürümez: Her salonun `SiteGroupId` değeri sitenin kendi şehir listesiyle eşleştirilir. Böylece 77 salonun tamamında şehir ve koordinat bilgisi kesin doğrulukla gelir.

---

## Gece Seansları

Bir salon 01:30 seansını 2 Ağustos listesinde gösterebilir, ancak o seans teknik olarak 3 Ağustos'a aittir. Site altyapısı bu durumu kendisi şu şekilde işaretler:

```html
<div id="showtime-20260803013000"
     data-warning="Seçtiğin seans 2.08.2026 tarihini 3.08.2026 tarihine bağlayan geceye aittir.">
  01:30
</div>
```

HTML öğesinin kimliği (ID) gerçek tarihi, `data-warning` özelliği ise Türkçe açıklamayı barındırır. Uygulama bu durumu listede **+1 gün** rozetiyle gösterir. Seansa tıkladığınızda sitenin kendi metnini barındıran bir uyarı çıkar ve **Tamam** butonuna basmadan koltuk planı açılmaz.

---

## Hız ve İstek Limitleri (Rate Limiting)

API istekleri iki farklı kulvarda yönetilir:

- **Etkileşimli Kulvar** (Kullanıcının beklediği anlık işlemler): Aynı anda 6 istek kapasitesi, istekler arası ~200 ms bekleme.
- **Arka Plan Kulvarı** (Sadece takip listesinin yenilenmesi): Aynı anda 1 istek kapasitesi, istekler arası 1,2 sn bekleme.

Bir film + salon + tarih kombinasyonu için **bütün** seanslar taranır ve herhangi bir üst sınır yoktur. Yapılan ölçümlerde 23 seansın taranması **6,1 saniye**, önbellek (cache) sıcakken ise sadece 0,4 saniye sürmüştür.

**Emniyet Freni:** Hedef site `429` (Too Many Requests) veya `403` (Forbidden) hataları döndürürse ya da üst üste üç istek başarısız olursa, etkileşimli kulvar 15 dakikalığına yavaş kulvar hızına düşürülür. Bu durum Durum sekmesinde kullanıcıya bildirilir ve süre dolduğunda sistem kendiliğinden normal hızına döner.

Otomatik tarama özelliği Durum sekmesinden kapatılabilir. Kapatıldığında, koltuk verileri sadece bir seansa tıklandığında çekilir.

---

## Koltuk Seçim Algoritması

Salon boyutları 7×9'dan 15×39'a kadar değişiklik gösterir (55 koltuktan 456 koltuğa kadar - yaklaşık 8 kat fark). Bu nedenle algoritma, dinamik olarak salon boyutuna göre ölçeklenir:

- Derinlik hesabı yalnızca **koltuk bulunan** sıralar üzerinden yapılır (Her salonda `data-r` niteliğinin atladığı boş bir ara koridor sırası bulunur).
- Kenar dezavantajı (penalty), ilgili sıranın toplam genişliğine göre hesaplanır. Aksi takdirde 7 koltuklu dar bir sırada her koltuk "kenar" olarak algılanabilirdi.
- Sığ salonlarda koltuk dağılımını dengelemek için Gauss eğrisi genişletilir.
- Farklı salonların skorları birbiriyle karşılaştırılmadan önce kendi içlerinde normalize edilir.
- Yalnızca `data-allowed-cc` niteliğiyle eşleşen koltuklar öneri havuzuna alınır (Örneğin, Gold Class biletiyle standart koltuk seçilemez).

Sıra 0, salonun **en arka** kısmını temsil eder. Harfler perdeye doğru yaklaştıkça küçülür (G→A, O→A, K→A mantığı sahada doğrulanmıştır).

---

## Proje Yapısı

```text
electron/main.js          Masaüstü penceresi; Express sunucusunu kendi içinde başlatır.
src/config.js             Tek yapılandırma dosyası (yalnızca uygulamanın kendi politikaları).
src/net/client.js         İki kulvarlı HTTP istemcisi (zaman aşımı, yeniden deneme, emniyet freni).
src/net/cineverse.js      Dört temel katalog API'si + koltuk seçim akışı.
src/parse/sessions.js     Seans verilerini ayrıştırır (teknoloji, format, gece seansı tespiti).
src/parse/seatmap.js      #seatContainer yapısını ızgaraya (grid) dönüştürür.
src/parse/ticket.js       Token ve bilet tiplerini ayrıştırır (satışta olmayanları filtreler).
src/algo/seatDetection.js Salon boyutuna duyarlı koltuk sıralama algoritması.
src/seats.js              Önbellek yönetimi, düşük maliyetli token üretimi, paralel tarama.
src/store.js              Küçük boyutlu JSON veritabanı (favoriler, takip edilenler, ayarlar).
src/api/routes.js         Uygulamanın HTTP arayüzü.
public/                   Üç panelli kullanıcı arayüzü (frontend).
tools/make-icon.js        build/icon.ico dosyasını üretir.
```

Kullanıcı ayarları ve takip listesi tek bir JSON dosyasında saklanır (dosyanın yolu Durum sekmesinde görüntülenebilir). Herhangi bir dış veritabanı (SQL/NoSQL) kullanılmaz; bu sayede yerel derleme (native build) gerektiren uğraştırıcı bağımlılıklar ortadan kaldırılmıştır.

---

## Testler

```bash
npm test
```

Projeye dahil 50 adet test bulunmaktadır. Koltuk planı test verileri (fixtures) 71, 125 ve 256 koltukluk üç farklı salon boyutundan alınmıştır. Bunun sebebi, algoritmanın başlangıçta sadece 256 koltukluk bir salona göre ayarlanmış olması ve bu boyutun diğer küçük/büyük salonları tam temsil edememesiydi.

Sitenin altyapısı değişirse test verilerini kolayca yenileyebilirsiniz:

```bash
npm run capture:fixtures
```

Ayrıştırıcılar (parsers) boş bir sonuç döndürmek yerine doğrudan **hata fırlatacak** şekilde tasarlanmıştır. İlk sürümün en büyük problemi hataları sessizce yutmasıydı (silent failure); güncel testler tam olarak bu durumun tekrarlanmasını önlemek için yazılmıştır.

---

## Kısıtlamalar ve Bilinmesi Gerekenler

- Uygulamanın kullandığı API'ler, sitenin kendi arayüzünün (frontend) kullandığı belgelenmemiş (undocumented) uç noktalardır. Haber verilmeksizin değişebilirler; böyle bir durumda testler hata verecektir.
- Koltuk planı sorgulamak, sunucu tarafında geçici bir sepet oluşturur. Ancak bu işlem; giriş yapmayı, ödeme adımını veya koltukları kilitlemeyi içermez. Sitede gezinirken herhangi bir kullanıcının "Devam Et" butonuna basmasından farksızdır. Yine de otomatik tarama açıkken bu işlem, tıkladığınız her seans için arka planda tekrarlanır.
- Bilet fiyatları uygulama içinde gösterilir, fakat uygulama hiçbir şekilde satın alma sürecine müdahil olmaz veya bilet almaz.
