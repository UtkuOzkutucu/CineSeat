# CineSeat

Paribu Cineverse için geliştirilmiş gayriresmi masaüstü uygulaması. Uygulama; sinema, film ve seans seçtiğinizde o seansın koltuk planını anlık olarak okur. Ardından belirttiğiniz kişi sayısı kadar yan yana ve salonun en iyi konumunda bulunan koltukları size önerir:

> **I sırası, koltuk 7-8** · %100 uygunluk

Uygulama üzerinden herhangi bir satın alma işlemi gerçekleştirilmez. Üyelik girişi gerektirmez, ödeme almaz ve koltuk ayırtmaz; yalnızca boş koltukların durumunu okur. "Bilet Al" düğmesi, işlemi tamamlamanız için sizi sitenin orijinal bilet alma sayfasına yönlendirir.

---

## Kurulum

1. [**Releases**](https://github.com/UtkuOzkutucu/CineSeat/releases) sayfasından `CineSeat-Setup-3.0.0.exe` dosyasını indirin.
2. Dosyayı çalıştırıp kurulumu tamamlayın.
3. Kurulum tamamlandıktan sonra uygulamaya Başlat menüsünden veya masaüstü kısayolundan erişebilirsiniz.

Uygulama, Windows 10 veya 11 (64-bit) işletim sistemlerinde çalışır. Ek bir yazılım kurmanıza gerek yoktur.

### "Windows bilgisayarınızı korudu" Uyarısı

Kurulum dosyasını ilk açtığınızda Windows mavi bir SmartScreen uyarı ekranı gösterebilir. Bunun sebebi uygulamanın zararlı bir yazılım olması değil, **dijital imza sertifikasına sahip olmamasıdır**. Bu sertifikalar yıllık belirli bir ücret gerektirdiği için bu tarz kişisel açık kaynaklı projelerde genellikle bulunmaz. Windows, imzasız tüm programlar için bu standart uyarıyı göstermektedir.

Kuruluma devam etmek için: **Ek bilgi** → **Yine de çalıştır** seçeneklerine tıklayabilirsiniz.

---

## Nasıl Kullanılır?

Üst menüden bilet alacağınız kişi sayısını seçtikten sonra aşağıdaki adımları izleyebilirsiniz:

- **Sinema ve Film Seçimi:** Seçimi dilediğiniz sırayla yapabilirsiniz. Ortadaki **⇄** düğmesi, sinema ve film filtrelerinin yerini değiştirir. İsterseniz önce sinemayı seçip o sinemadaki filmleri listeleyebilir, isterseniz de önce filmi seçip o filmin gösterimde olduğu sinemaları görüntüleyebilirsiniz.
- **Tarih Seçimi:** Bir tarih seçtiğinizde, o güne ait tüm seanslar taranır ve her seansın altında en uygun koltuk bilgisi gösterilir. Renk kodları şu şekildedir: Yeşil kenarlık iyi konumdaki koltukları, sarı kenarlık orta konumdaki koltukları, gri kenarlık ise "yan yana boş yer olmadığını" ifade eder.
- **Gece Seansları:** **+1 gün** rozetine sahip olan seanslar gece yarısından sonra başlamaktadır; bu nedenle takvim bazında aslında bir sonraki güne aittir. Bu seanslara tıkladığınızda bilgilendirici bir uyarı mesajı ile karşılaşırsınız.
- **Koltuk Planı:** İlgili seansa tıkladığınızda koltuk planı açılır ve sistem tarafından size önerilen koltuklar altın rengiyle vurgulanır.

İlgilendiğiniz bir seansı **Takibe Al** seçeneği ile **Takip** sekmesine ekleyebilirsiniz. Bu sayede o seanstaki boş koltuk sayısı arka planda otomatik olarak güncellenir.

---

## Nasıl Çalışır?

Uygulama, resmi sitenin bilet sayfasının arka planda kullandığı API uç noktalarından (endpoints) faydalanır. Uygulama üzerindeki her panel tek bir API isteği yapar ve bu isteklerin her biri genellikle 100 milisaniyenin altında sonuçlanır. Bu sayede arka planda sürekli veri toplayan bir servis veya yerel bir veritabanı bulunmaz; ekranda gördüğünüz tüm veriler o an canlı olarak sunucudan çekilir.

| Uç Nokta (Endpoint) | Dönen Veri |
|---|---|
| `POST /Cinema/GetCinemaListsByFilter` | 77 sinema: Kod, şehir, salon teknolojileri ve konum |
| `POST /Film/GetAllowedSalesFilmsByFilter` | Vizyonda bileti satışta olan filmler |
| `POST /Film/GetFilmSessionDatesView` | Bilet satışına açık olan tarihler |
| `POST /Film/GetFilmSessionsView` | Sitenin kendi gruplandırdığı şekilde seans saatleri |

Bu uç noktalar çift yönlü çalışır: İstek parametresi olarak sinema kimliği (ID) gönderirseniz o sinemadaki filmleri, film kimliği gönderirseniz o filmin gösterildiği sinemaları döndürür. Arayüzdeki **⇄** düğmesi temelde bu çalışma mantığına dayanır.

### Hız ve Optimizasyon

API istekleri iki farklı işlem kuyruğuna ayrılır: Kullanıcı arayüzünde aktif olarak beklerken çalışanlar (aynı anda maksimum 6 istek) ve takip listesini güncelleyen arka plan görevleri (aralarında 1,2 saniye bekleme süresi olan, aynı anda tek istek).

Seçili bir sinema, film ve tarih kombinasyonu için **tüm** seanslar taranır, herhangi bir sayı sınırı uygulanmaz. Yapılan ölçümlere göre; 23 adet seansın taranması yaklaşık **6-8 saniye** sürerken, veriler önbellekte (cache) taze ise bu süre yarım saniyenin altına düşmektedir.

Karşı sunucu tarafından API isteklerine sınırlandırma getirilirse (örn. `429` veya `403` durum kodları) veya üst üste üç istek başarısız olursa, uygulama koruma amacıyla kendini 15 dakikalığına bekleme moduna alır. Bu durum **Durum** sekmesinde kullanıcıya bildirilir ve süre dolduğunda uygulama normal hızına döner. Dilerseniz otomatik taramayı aynı sekmeden devre dışı bırakabilirsiniz; bu durumda koltuk bilgileri yalnızca ilgili seansa tıkladığınızda sorgulanır.

---

## Dinamik Veri Yapısı (Koda Gömülü Değer Bulunmaz)

Bilet kodları, fiyatlar ve koltuk kategorileri şehirden şehre değişiklik göstermektedir. Altı farklı ilde yapılan ölçüm sonuçları şöyledir:

| Şehir | Bilet Kodları | Fiyatlar | Koltuk Kategorisi |
|---|---|---|---|
| Bolu | `0231` / `0235` | 295 ₺ / 270 ₺ | `0000000001` |
| Çanakkale | `0247` / `0249` | 260 ₺ / 260 ₺ | `0000000001` |
| Kocaeli | `0002` / `0006` | 355 ₺ / 330 ₺ | `0000000001` |
| İstanbul Avrupa | `1250` / `1310` | 735 ₺ / 685 ₺ | `0000000010` |
| İstanbul Anadolu | `1058` / `1098` | 795 ₺ / 750 ₺ | `0000000012` |
| Ankara | `0002` / `0006` | 400 ₺ / 370 ₺ | `0000000001` |

Örneğin; aynı `0002` bilet kodu Kocaeli'de 355 ₺ iken Ankara'da 400 ₺ olarak fiyatlandırılmaktadır. Bu sebeple yalnızca bilet koduna bakarak fiyatı tahmin etmek mümkün değildir. Ayrıca, Gold Class salonları standart koltuk kategorilerinden farklı çalışmaktadır. Tüm bu nedenlerden ötürü, bilet fiyatları ve koltuk kategorileri gibi değişken değerler her seans için sunucudan anlık olarak okunur.

Aynı şekilde şehir bilgisi de tahmine dayalı değildir; her sinemanın grup kimliği (ID), doğrudan resmi sitenin şehir listesiyle eşleştirilir. Bu yöntem sayesinde 77 sinemanın tamamında şehir ve konum bilgileri hatasız olarak elde edilmektedir.

---

## Gece Seansları

Sinema sistemleri genellikle gece 01:30 seansını örneğin 2 Ağustos tarihi altında listeler; ancak bu seans takvim bazında aslında 3 Ağustos'a aittir. Resmi site bu durumu kendi verisinde özel olarak işaretlemektedir:

```html
<div id="showtime-20260803013000"
     data-warning="Seçtiğin seans 2.08.2026 tarihini 3.08.2026 tarihine bağlayan geceye aittir.">
  01:30
</div>
```

HTML öğesinin `id` değerinde gerçek tarih, `data-warning` niteliğinde ise sitenin kendi hazırladığı açıklama metni yer alır. Bu doğrultuda uygulama, ilgili seanslar için listede **+1 gün** rozeti gösterir. Seansa tıkladığınızda ise bu açıklamanın bulunduğu bir onay kutusu (uyarı) karşınıza çıkar ve **Tamam** butonuna basmadan koltuk planı görüntülenmez.

---

## Koltuk Seçimi Algoritması

Sinema salonlarının boyutları 7×9'dan 15×39'a kadar değişiklik göstermektedir; en küçük salon 55, en büyük salon ise 456 koltukludur. Salon kapasiteleri arasında yaklaşık sekiz katlık bir fark bulunduğundan, ideal koltuğu bulan sıralama algoritması salon boyutuna göre dinamik olarak ölçeklenmektedir:

- **Derinlik Hesaplaması:** Derinlik (perdeye olan mesafe), yalnızca koltuk bulunan sıralar üzerinden hesaplanır. Hemen her salonda yer alan ara koridor boşlukları, site tarafından numaralandırmada atlandığı için hesaplamaya dahil edilmez.
- **Kenar Koltuk Puanlaması:** Kenar koltuklara uygulanan eksi puan (ceza), sıranın toplam genişliğine göre orantısal olarak ayarlanır. Bu ceza değeri sabit olsaydı, örneğin 7 koltuklu dar bir sırada neredeyse tüm koltuklar "kenar" kabul edilerek haksız bir puanlama yapılırdı.
- **Esnek İdeal Aralık:** Toplam sıra sayısının az olduğu küçük salonlarda, ideal izleme mesafesini kapsayan derinlik aralığı otomatik olarak genişletilir.
- **Puan Normalizasyonu:** Farklı salonlara ait koltuk puanları birbirleriyle kıyaslanmadan önce kendi içlerinde 0 ile 100 arasına çekilerek normalleştirilir.
- **Kategori Kontrolü:** Uygulama her zaman seçilen bilet kategorisine uygun koltukları önerir (örn. standart bir bilet türü seçiliyken Gold Class koltukları önerilmez).

*Not: Site yapısı gereği salonun en arka sırası başlangıç noktası (0. indeks) olarak kabul edilir ve harflendirme perdeye doğru azalır.*

---

## Kaynaktan Derleme (Build)

`BUILD-APP.bat` dosyasına çift tıklayarak derleme sürecini başlatabilirsiniz. Bu betik, gerekli bağımlılıkları otomatik olarak kurar ve `dist` klasörünün içerisine kurulum dosyasını (`.exe`) üretir. Terminal kullanmayı tercih ederseniz aşağıdaki komutu çalıştırabilirsiniz:

```bash
npm install && npm run dist
```

Geliştirme aşamasında uygulamayı derlemeden doğrudan pencere olarak açmak için:

```bash
npm run app
```

Yalnızca arka plan sunucusunu çalıştırıp arayüze tarayıcı üzerinden erişmek için:

```bash
npm start
```

Projeyi derlemek veya çalıştırmak için Node.js 18 veya üzeri bir sürüm gereklidir. Projede derleme (native build) gerektiren ek bir kütüphane, harici bir veritabanı sunucusu ya da Docker bağımlılığı bulunmamaktadır.

### Proje Yapısı

```
electron/main.js           Masaüstü pencere yönetimi; Express sunucusunu kendi içinde başlatır
src/config.js              Uygulama ayarları (yalnızca yerel davranışlar, siteye ait veri içermez)
src/net/client.js          Çift kuyruklu HTTP istemcisi (istek tekrarlama ve bekleme mekanizmaları)
src/net/cineverse.js       Katalog uç noktaları ve koltuk planı veri akışı
src/parse/                 Sunucudan gelen HTML verilerini ayrıştıran (parse eden) modüller
src/algo/seatDetection.js  Salon boyutuna göre dinamik ölçeklenen koltuk bulma algoritması
src/seats.js               Veri önbellekleme (cache) ve paralel istek yönetimi
src/store.js               Yerel veritabanı yedeği olarak çalışan ufak JSON dosyası (favoriler, takipler, ayarlar)
src/api/routes.js          Arayüz ile haberleşen yerel HTTP rotaları (routes)
public/                    Kullanıcı arayüzünü (UI) barındıran klasör (üç panelli tasarım)
```

Uygulamaya ait ayarlar ve takip listesi verileri sistemde tek bir JSON dosyasında tutulur. Bu dosyanın tam yolunu uygulama içindeki **Durum** sekmesinden öğrenebilirsiniz.

### Testler

```bash
npm test
```

Komut çalıştırıldığında 50 adet birim testi yürütülür. Testlerde kullanılan koltuk planı örnek verileri (fixtures) üç farklı salon boyutundan (71, 125 ve 256 koltuk) alınmıştır. Bunun sebebi, sıralama algoritmasının ilk sürümlerde yalnızca 256 koltukluk bir salona göre tasarlanmış olması ve bu tekil durumun diğer salon türlerini doğru temsil edememesiydi.

Eğer sitenin arayüzünde veya veri yapısında bir değişiklik olursa, testlerde kullanılan örnek verileri (fixtures) güncellemek için:

```bash
npm run capture:fixtures
```

Uygulamadaki ayrıştırıcılar (parsers) veriyi okuyamadığında boş bir sonuç döndürmek yerine doğrudan **hata (exception) fırlatır**. Projenin ilk sürümündeki en büyük yapısal hata sessizce başarısız olmasıydı (silent failure); boş sonuçlar geçerli veri gibi algılanıyor, önbelleğe yazılıyor ve kullanıcıya "salonda yer yok" şeklinde yanlış bilgi yansıtılıyordu. Test paketi ve katı hata yönetimi, bu sorunun tekrar yaşanmasını engellemek amacıyla oluşturulmuştur.

---

## Kısıtlamalar ve Bilinmesi Gerekenler

- Uygulamanın kullandığı uç noktalar (endpoints) tamamen resmi sitenin kendi arayüzüne aittir ve açık bir şekilde belgelenmemiştir (undocumented). Bu API yapısı haber verilmeksizin değiştirilebilir. Böyle bir durumda uygulamanın birim testleri hata vermeye başlayacaktır.
- Sunucudan koltuk planı verisini çekebilmek için arka planda geçici bir sepet oturumu (session) oluşturulması gerekmektedir. Bu işlem herhangi bir üyelik girişi, ödeme adımı veya koltuk kilitleme işlemi içermez; standart bir ziyaretçinin tarayıcıda koltuk seçimi adımına geçmesiyle birebir aynıdır. Yine de otomatik tarama aktif olduğunda, bu geçici sepet oluşturma işlemi görüntülenen her seans için arka planda tekrarlanır.
- Uygulama güncel bilet fiyatlarını okuyup gösterir; ancak hiçbir aşamada satın alma veya ödeme adımlarına dahil olmaz.

---

## Yasal Uyarı (Legal Disclaimer)

Bu proje (CineSeat) tamamen bağımsız, kişisel ve açık kaynaklı bir geliştirme çalışmasıdır. **Paribu Cineverse**, **CGV Mars Cinema Group** veya ilgili herhangi bir ticari kuruluş ile hiçbir resmi bağı, ortaklığı, sponsorluğu veya anlaşması bulunmamaktadır. 

- Uygulama; bilet satışı yapmaz, ödeme bilgilerini işlemez ve herhangi bir kişisel veri toplamaz.
- Kullanılan veriler, sitenin bilet satış sayfalarında anlık olarak ziyaretçilere sunulan herkese açık bilgilerin derlenmesinden ibarettir. 
- Sunulan koltuk bilgilerinin veya fiyatların %100 doğruluğu ya da sürekliliği garanti edilmez; API yapısındaki olası değişiklikler nedeniyle uygulama geçici veya kalıcı olarak çalışmayı durdurabilir.
- Uygulamanın kullanımı tamamen son kullanıcının kendi sorumluluğundadır. Bu yazılımın kullanımından doğabilecek dolaylı veya dolaysız hiçbir maddi/manevi zarardan (biletin yanlış alınması, IP adresinin geçici olarak kısıtlanması vb.) geliştirici sorumlu tutulamaz.

Ticari marka hakları ve sistem verileri ilgili sahiplerine aittir. Bu proje yalnızca kişisel kullanım, eğitim ve kolaylık sağlama amacıyla geliştirilmiştir.
