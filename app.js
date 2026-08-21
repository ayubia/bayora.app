let products = {

    pulsa: [
        {
            id: "tsel10",
            name: "Telkomsel 10K",
            price: 12500,
            info: "Pulsa Rp10.000"
        },
        {
            id: "tsel20",
            name: "Telkomsel 20K",
            price: 22500,
            info: "Pulsa Rp20.000"
        },
        {
            id: "tsel25",
            name: "Telkomsel 25K",
            price: 27500,
            info: "Pulsa Rp25.000"
        },
        {
            id: "tsel50",
            name: "Telkomsel 50K",
            price: 52500,
            info: "Pulsa Rp50.000"
        },
        {
            id: "tsel100",
            name: "Telkomsel 100K",
            price: 102500,
            info: "Pulsa Rp100.000"
        }
    ],

    data: [
        {
            id: "data5",
            name: "Internet 5 GB",
            price: 18000,
            info: "Masa aktif 7 hari"
        },
        {
            id: "data10",
            name: "Internet 10 GB",
            price: 28000,
            info: "Masa aktif 15 hari"
        },
        {
            id: "data15",
            name: "Internet 15 GB",
            price: 39000,
            info: "Masa aktif 30 hari"
        },
        {
            id: "data25",
            name: "Internet 25 GB",
            price: 55000,
            info: "Masa aktif 30 hari"
        }
    ],

    "pln-token": [
        {
            id: "pln20",
            name: "Token 20K",
            price: 22500,
            info: "Nominal Rp20.000"
        },
        {
            id: "pln50",
            name: "Token 50K",
            price: 52500,
            info: "Nominal Rp50.000"
        },
        {
            id: "pln100",
            name: "Token 100K",
            price: 102500,
            info: "Nominal Rp100.000"
        },
        {
            id: "pln200",
            name: "Token 200K",
            price: 202500,
            info: "Nominal Rp200.000"
        },
        {
            id: "pln500",
            name: "Token 500K",
            price: 502500,
            info: "Nominal Rp500.000"
        }
    ],

    ewallet: [
        {
            id: "dana20",
            name: "DANA 20K",
            price: 22500,
            info: "Top up Rp20.000"
        },
        {
            id: "ovo20",
            name: "OVO 20K",
            price: 22500,
            info: "Top up Rp20.000"
        },
        {
            id: "gopay20",
            name: "GoPay 20K",
            price: 22500,
            info: "Top up Rp20.000"
        },
        {
            id: "spay20",
            name: "ShopeePay 20K",
            price: 22500,
            info: "Top up Rp20.000"
        }
    ]

};


let services = {

    pulsa: {
        title: "Pulsa",
        icon: "📱",
        description: "Pilih pulsa sesuai kebutuhanmu.",
        label: "Nomor HP",
        placeholder: "08xxxxxxxxxx"
    },

    data: {
        title: "Paket Data",
        icon: "🌐",
        description: "Pilih paket internet yang kamu butuhkan.",
        label: "Nomor HP",
        placeholder: "08xxxxxxxxxx"
    },

    "pln-token": {
        title: "Token PLN",
        icon: "⚡",
        description: "Pilih nominal token listrik.",
        label: "Nomor Meter / ID Pelanggan",
        placeholder: "Masukkan nomor meter"
    },

    "pln-bill": {
        title: "Tagihan PLN",
        icon: "💡",
        description: "Masukkan ID pelanggan untuk melihat tagihan.",
        label: "ID Pelanggan",
        placeholder: "Masukkan ID pelanggan"
    },

    ewallet: {
        title: "E-Wallet",
        icon: "💰",
        description: "Pilih saldo e-wallet yang ingin diisi.",
        label: "Nomor HP",
        placeholder: "08xxxxxxxxxx"
    },

    bpjs: {
        title: "BPJS",
        icon: "🏥",
        description: "Masukkan nomor peserta BPJS.",
        label: "Nomor Peserta",
        placeholder: "Masukkan nomor peserta"
    }

};



/* =========================================================
   BAYORA — PAGE PERSISTENCE
   Mempertahankan halaman terakhir saat browser di-refresh.
========================================================= */

const BAYORA_PAGE_STATE_KEY =
    "bayora_last_page";

function saveBayoraPage(page) {

    try {

        sessionStorage.setItem(
            BAYORA_PAGE_STATE_KEY,
            page
        );

    } catch (error) {

        console.warn(
            "Gagal menyimpan halaman BAYORA.",
            error
        );

    }

}


function getBayoraSavedPage() {

    try {

        return sessionStorage.getItem(
            BAYORA_PAGE_STATE_KEY
        );

    } catch (error) {

        console.warn(
            "Gagal membaca halaman BAYORA.",
            error
        );

        return null;

    }

}


function clearBayoraSavedPage() {

    try {

        sessionStorage.removeItem(
            BAYORA_PAGE_STATE_KEY
        );

    } catch (error) {

        console.warn(
            "Gagal menghapus state halaman BAYORA.",
            error
        );

    }

}


let currentService = null;
let currentProduct = null;

window.showAllDigitalProducts = false;

let selectedDigitalProducts = [];

let digitalCustomerEmail = "";
let digitalCustomerWhatsapp = "";
let selectedDigitalDevice = "";


/* =========================================================
   BAYORA — RESTORE LAST PAGE
========================================================= */

function restoreBayoraLastPage() {

    /*
     * Jangan restore halaman terakhir ketika user
     * sedang kembali dari Xendit.
     *
     * Xendit menggunakan query:
     * ?payment=success&transactionId=...
     * atau:
     * ?payment=cancel&transactionId=...
     *
     * handleXenditReturn() harus menjadi pemilik
     * tampilan pada kondisi tersebut.
     */
    const returnParams =
        new URLSearchParams(
            window.location.search
        );

    const returnPayment =
        returnParams.get("payment");

    const returnTransactionId =
        returnParams.get("transactionId");

    if (
        returnTransactionId &&
        (
            returnPayment === "success" ||
            returnPayment === "cancel"
        )
    ) {
        return;
    }

    const savedPage =
        getBayoraSavedPage();

    if (!savedPage) {
        return;
    }


    /*
     * HOME
     */
    if (savedPage === "home") {

        showHome();

        return;
    }


    /*
     * SERVICE
     */
    if (
        savedPage.startsWith("service:")
    ) {

        const serviceId =
            savedPage.substring(
                "service:".length
            );

        if (
            serviceId &&
            services[serviceId]
        ) {

            openService(serviceId);

        } else {

            console.warn(
                "[BAYORA] Service terakhir tidak ditemukan:",
                serviceId
            );

            clearBayoraSavedPage();

        }

        return;
    }


    /*
     * CHECKOUT
     *
     * Checkout tidak dipulihkan langsung
     * karena data transaksi belum disimpan.
     * Kembalikan user ke service terakhir.
     */
    if (savedPage === "checkout") {

        let lastService = null;

        try {

            lastService =
                sessionStorage.getItem(
                    "bayora_last_service"
                );

        } catch (error) {

            console.warn(
                "Gagal membaca service terakhir.",
                error
            );

        }


        if (
            lastService &&
            services[lastService]
        ) {

            openService(lastService);

        } else {

            showHome();

        }

    }

}


/* =========================
   DYNAMIC CATALOG
========================= */

async function loadCustomerCatalog() {

    try {

        const response =
            await fetch("/api/catalog");

        const data =
            await response.json();

        if (!response.ok || !data.success) {
            throw new Error(
                data.error ||
                "Gagal mengambil katalog."
            );
        }


        /*
         * SERVICES
         * API:
         * [
         *   { id, title, icon, description,
         *     label, placeholder, active }
         * ]
         */

        const apiServices = {};

        (data.services || []).forEach(service => {

            if (!Number(service.active)) {
                return;
            }

            apiServices[service.id] = {
                title: service.title,
                icon: service.icon,
                description: service.description,
                label: service.label,
                placeholder: service.placeholder,
                type: service.type || "ppob"
            };

        });


        /*
         * PRODUCTS
         * API:
         * [
         *   { id, service_id, operator,
         *     name, price, info, active }
         * ]
         */

        const apiProducts = {};

        (data.products || []).forEach(product => {

            if (!Number(product.active)) {
                return;
            }

            if (!apiProducts[product.service_id]) {
                apiProducts[product.service_id] = [];
            }

            apiProducts[product.service_id].push({
                id: product.id,
                name: product.name,
                price: Number(product.price) || 0,
                mood: product.mood || "",
                info: product.info || "",
                operator: product.operator || "",
                productType: product.product_type || "ppob",
                previewImage: product.preview_image || "",
                beforeImage: product.before_image || "",
                afterImage: product.after_image || "",
                galleryImages: (() => {
                    if (!product.gallery_images) {
                        return [];
                    }

                    if (Array.isArray(product.gallery_images)) {
                        return product.gallery_images.filter(Boolean);
                    }

                    try {
                        const parsed =
                            JSON.parse(product.gallery_images);

                        return Array.isArray(parsed)
                            ? parsed.filter(Boolean)
                            : [];
                    } catch (error) {
                        console.warn(
                            "[DIGITAL PRODUCT] Gallery JSON tidak valid:",
                            error
                        );

                        return [];
                    }
                })()
            });

        });


        /*
         * Hanya mengganti data kalau API
         * benar-benar mengembalikan katalog.
         */

        services = apiServices;
        products = apiProducts;

        console.log(
            "[BAYORA ICON DEBUG]",
            Object.entries(services).map(
                ([id, service]) => ({
                    id,
                    title: service.title,
                    type: service.type,
                    icon: service.icon
                })
            )
        );

        renderCustomerServices();

        /*
         * BAYORA — OPEN SHARED SERVICE
         *
         * Jika halaman dibuka melalui:
         * ?service=SERVICE_ID
         *
         * buka langsung halaman layanan tersebut.
         *
         * Halaman layanan sudah menangani:
         * - informasi layanan
         * - katalog produk layanan
         * - form sesuai layanan
         *
         * PPOB maupun Digital mengikuti flow normal.
         */
        const sharedServiceId =
            new URLSearchParams(
                window.location.search
            ).get("service");

        if (sharedServiceId) {

            const sharedService =
                services[sharedServiceId];

            if (sharedService) {

                /*
                 * Samakan kategori dengan layanan
                 * yang dibagikan.
                 */
                if (
                    typeof setCustomerServiceCategory ===
                    "function"
                ) {
                    setCustomerServiceCategory(
                        sharedService.type === "digital"
                            ? "digital"
                            : "ppob"
                    );
                }

                /*
                 * Gunakan flow layanan normal.
                 *
                 * Ini penting karena openService()
                 * menyiapkan produk + form sesuai
                 * layanan yang dipilih.
                 */
                openService(sharedServiceId);

            } else {

                console.warn(
                    "[BAYORA SHARE] Layanan tidak ditemukan:",
                    sharedServiceId
                );

                showHome();

            }

            return;

        }


        /*
         * BAYORA — OPEN SHARED PRODUCT
         *
         * Jika halaman dibuka melalui:
         * ?product=PRODUCT_ID
         *
         * cari produk dari katalog database,
         * buka layanan terkait, lalu buka detail
         * produk digital jika memang produk digital.
         */
        const sharedProductId =
            new URLSearchParams(
                window.location.search
            ).get("product");

        if (sharedProductId) {

            let sharedProduct = null;
            let sharedServiceId = null;

            Object.entries(products)
                .some(([serviceId, serviceProducts]) => {

                    const found =
                        serviceProducts.find(
                            product =>
                                String(product.id) ===
                                String(sharedProductId)
                        );

                    if (!found) {
                        return false;
                    }

                    sharedProduct = found;
                    sharedServiceId = serviceId;

                    return true;
                });

            if (
                sharedProduct &&
                sharedServiceId &&
                services[sharedServiceId]
            ) {

                openService(sharedServiceId);

                if (
                    sharedProduct.productType ===
                    "digital"
                ) {

                    setTimeout(() => {

                        openDigitalProductDetail(
                            sharedProduct
                        );

                    }, 0);

                }

            } else {

                console.warn(
                    "[BAYORA SHARE] Produk tidak ditemukan:",
                    sharedProductId
                );

            }

        } else {

            restoreBayoraLastPage();

        }

        console.log(
            "Katalog customer berhasil dimuat dari database.",
            {
                services: Object.keys(services),
                products
            }
        );


    } catch (error) {

        /*
         * Jangan merusak website kalau API gagal.
         * Data hardcoded lama tetap digunakan.
         */

        console.warn(
            "Katalog database gagal dimuat. Menggunakan katalog fallback.",
            error
        );

    }

}


/*
 * Mulai mengambil katalog dari database.
 * Fungsi ini tidak mengubah tampilan lama
 * kalau request gagal.
 */

loadCustomerCatalog();


let customerServiceCategory = "ppob";


function setCustomerServiceCategory(category) {

    customerServiceCategory =
        category === "digital"
            ? "digital"
            : "ppob";

    renderCustomerServices();

}


function renderCustomerServices() {

    const grid =
        document.getElementById("customerServiceGrid");

    if (!grid) {
        console.warn(
            "customerServiceGrid tidak ditemukan."
        );
        return;
    }

    const entries =
        Object.entries(services || {});

    const ppobServices =
        entries.filter(([, service]) =>
            (service.type || "ppob") === "ppob"
        );

    const digitalServices =
        entries.filter(([, service]) =>
            service.type === "digital"
        );


    
const BAYORA_SERVICE_ICONS = {

    "pulsa": "pulsa.png",

    "data": "internet.png",
    "paket-data": "paket-data.png",
    "internet": "internet.png",

    "pln-token": "token-pln.png",
    "token-pln": "token-pln.png",

    "pln-bill": "tagihan-pln.png",
    "tagihan-pln": "tagihan-pln.png",

    "ewallet": "e-wallet.png",
    "e-wallet": "e-wallet.png",

    "bpjs": "bpjs.png",

    "games": "games.png",
    "game": "games.png",

    "aktivasi-voucher": "aktivasi-voucher.png",
    "voucher-aktivasi": "aktivasi-voucher.png",

    "paket-sms-telpon": "paket-sms-telpon.png",
    "sms-telpon": "paket-sms-telpon.png",
    "sms": "paket-sms-telpon.png",
    "telpon": "paket-sms-telpon.png",

    "tv": "tv-streaming.png",
    "tv-kabel": "tv-streaming.png",
    "tv-streaming": "tv-streaming.png",

    "masa-aktif": "masa-aktif.png",

    "aktivasi-perdana": "aktivasi-perdana.png",
    "perdana": "aktivasi-perdana.png",

    "voucher": "voucher-digital.png",
    "voucher-digital": "voucher-digital.png",

    "gas": "gas.png",
    "pdam": "gas.png",

    "zakat-donasi": "zakat-donasi.png",
    "zakat": "zakat-donasi.png",
    "donasi": "zakat-donasi.png",

    "voucher-game": "voucher-game.png",

    "voucher-belanja": "voucher-belanja.png",

    "tiket-kereta": "tiket-kereta.png",
    "kereta": "tiket-kereta.png",

    "tiket-pesawat": "tiket-pesawat.png",
    "pesawat": "tiket-pesawat.png",

    "template-media-sosial": "template-media-sosial.png",

    "ebook-template": "ebook-template.png",
    "ebook": "ebook-template.png",

    "musik-digital": "musik-digital.png",
    "musik": "musik-digital.png",

    "software-tools": "software-tools.png",
    "software": "software-tools.png",

    "preset-lightroom": "preset-lightroom.png",
    "lightroom": "preset-lightroom.png",
    "lightroom-preset": "preset-lightroom.png"

}

function getBayoraServiceIcon(id, service) {

    /*
     * PRIORITAS ICON BAYORA
     *
     * 1. Icon custom yang disimpan di database
     * 2. Icon BAYORA bawaan berdasarkan ID
     * 3. Icon BAYORA berdasarkan judul
     * 4. null -> fallback emoji
     */

    const customIcon =
        String(
            service?.icon || ""
        ).trim();

    /*
     * Jika admin sudah mengupload icon,
     * gunakan icon tersebut.
     */
    if (
        customIcon.startsWith("/") ||
        customIcon.startsWith("http://") ||
        customIcon.startsWith("https://")
    ) {

        return customIcon;

    }


    const normalizedId =
        String(id || "")
            .trim()
            .toLowerCase();


    if (BAYORA_SERVICE_ICONS[normalizedId]) {

        return BAYORA_SERVICE_ICONS[normalizedId];

    }


    const title =
        String(service?.title || "")
            .trim()
            .toLowerCase();


    const titleMap = [
        ["preset", "preset-lightroom.png"],
        ["lightroom", "preset-lightroom.png"],
        ["paket data", "paket-data.png"],
        ["pulsa", "pulsa.png"],
        ["token pln", "token-pln.png"],
        ["tagihan pln", "tagihan-pln.png"],
        ["e-wallet", "e-wallet.png"],
        ["ewallet", "e-wallet.png"],
        ["games", "games.png"],
        ["voucher game", "voucher-game.png"],
        ["voucher belanja", "voucher-belanja.png"],
        ["aktivasi voucher", "aktivasi-voucher.png"],
        ["masa aktif", "masa-aktif.png"],
        ["aktivasi perdana", "aktivasi-perdana.png"],
        ["paket sms", "paket-sms-telpon.png"],
        ["paket telpon", "paket-sms-telpon.png"],
        ["tv", "tv.png"],
        ["gas", "gas.png"],
        ["bpjs", "bpjs.png"],
        ["zakat", "zakat-donasi.png"],
        ["donasi", "zakat-donasi.png"],
        ["tiket kereta", "tiket-kereta.png"],
        ["tiket pesawat", "tiket-pesawat.png"],
        ["template media sosial", "template-media-sosial.png"],
        ["e-book", "ebook-template.png"],
        ["ebook", "ebook-template.png"],
        ["musik", "musik-digital.png"],
        ["desain", "desain-digital.png"],
        ["software", "software-tools.png"]
    ];


    for (const [keyword, icon] of titleMap) {

        if (title.includes(keyword)) {
            return icon;
        }

    }


    return null;

}


function getBayoraServiceIconHTML(id, service) {

    const iconValue =
        getBayoraServiceIcon(
            id,
            service
        );

    if (!iconValue) {
        return "📦";
    }

    const iconString =
        String(iconValue).trim();

    /*
     * Custom icon dari database sudah berupa
     * path lengkap:
     *
     * /assets/bayora-icons/xxxxx.png
     *
     * Jangan tambahkan folder lagi.
     */
    if (
        iconString.startsWith("/") ||
        iconString.startsWith("http://") ||
        iconString.startsWith("https://")
    ) {

        return `
            <img
                class="bayora-service-icon-image"
                src="${iconString.replace(/"/g, "&quot;")}"
                alt=""
                aria-hidden="true"
                draggable="false"
            >
        `;

    }

    /*
     * Icon bawaan BAYORA hanya berupa nama file.
     */
    return `
        <img
            class="bayora-service-icon-image${iconString === "preset-lightroom.png" ? " bayora-lightroom-icon" : ""}"
            src="/assets/bayora-icons/${iconString}"
            alt=""
            aria-hidden="true"
            draggable="false"
        >
    `;

}


    function renderCards(list) {

        if (!list.length) {

            return `
                <div class="customer-service-empty">
                    Belum ada layanan tersedia.
                </div>
            `;

        }

        return list.map(([id, service]) => {

            const safeId =
                String(id)
                    .replace(/\\/g, "\\\\")
                    .replace(/'/g, "\\\'");

            const icon =
                getBayoraServiceIconHTML(id, service);

            const title =
                service.title || "Layanan";

            const description =
                service.description || "";

            return `
                <div
                    class="service-card"
                    onclick="openService('${safeId}')"
                >

                    <div class="service-icon">
                        ${icon}
                    </div>

                    <div class="service-title">
                        ${title}
                    </div>

                    <div class="service-description">
                        ${description}
                    </div>

                </div>
            `;

        }).join("");

    }


    const isPpob =
        customerServiceCategory === "ppob";


    const activeServices =
        isPpob
            ? ppobServices
            : digitalServices;


    grid.innerHTML = `

        <div class="customer-service-tabs">

            <button
                type="button"
                class="customer-service-tab ${
                    isPpob ? "active" : ""
                }"
                onclick="setCustomerServiceCategory('ppob')"
            >
                <span class="customer-service-tab-icon">
                    <img
                        src="/assets/bayora-icons/layanan-ppob.png"
                        alt=""
                        aria-hidden="true"
                    >
                </span>

                <span>
                    <strong>Layanan PPOB</strong>
                    <small>
                        Pulsa, tagihan & pembayaran
                    </small>
                </span>

            </button>


            <button
                type="button"
                class="customer-service-tab ${
                    !isPpob ? "active" : ""
                }"
                onclick="setCustomerServiceCategory('digital')"
            >
                <span class="customer-service-tab-icon">
                    <img
                        src="/assets/bayora-icons/produk-digital.png"
                        alt=""
                        aria-hidden="true"
                    >
                </span>

                <span>
                    <strong>Produk Digital</strong>
                    <small>
                        Produk digital pilihan
                    </small>
                </span>

            </button>

        </div>


        <div class="customer-service-category">

            <div class="customer-service-category-header">

                <div class="service-section-title">

                    <h2>
                        ${
                            isPpob
                                ? "Layanan PPOB"
                                : "Produk Digital"
                        }
                    </h2>

                    <p>
                        ${
                            isPpob
                                ? "Penuhi kebutuhan pembayaran dan layanan sehari-hari."
                                : "Produk digital pilihan untuk kebutuhan kreatif dan sehari-hari."
                        }
                    </p>

                </div>

            </div>


            <div class="service-section-grid">

                ${renderCards(activeServices)}

            </div>

        </div>

    `;

}


let currentTarget = "";
let currentOperator = "";


function formatRupiah(number) {

    return new Intl.NumberFormat(
        "id-ID",
        {
            style: "currency",
            currency: "IDR",
            maximumFractionDigits: 0
        }
    ).format(number);

}


function showHome() {

    saveBayoraPage("home");

    document
        .getElementById("homePage")
        .classList.remove("page-hidden");

    document
        .getElementById("servicePage")
        .classList.add("page-hidden");

    document
        .getElementById("checkoutPage")
        .classList.add("page-hidden");

    document
        .getElementById("successPage")
        .classList.add("page-hidden");

    window.scrollTo({
        top: 0,
        behavior: "smooth"
    });

}



/* =========================================================
   BAYORA — GLOBAL SERVICE ICON HELPER
   Dipakai oleh openService() yang berada di global scope.
========================================================= */

function getBayoraServiceIconGlobal(id, service) {

    const customIcon =
        String(
            service?.icon || ""
        ).trim();

    /*
     * Custom uploaded icon.
     */
    if (
        customIcon.startsWith("/") ||
        customIcon.startsWith("http://") ||
        customIcon.startsWith("https://")
    ) {

        return customIcon;

    }

    /*
     * Fallback icon BAYORA berdasarkan ID.
     *
     * BAYORA_SERVICE_ICONS berada di scope yang sama
     * dengan helper lama, sehingga jangan bergantung
     * pada helper lama dari scope tersebut.
     */
    const normalizedId =
        String(id || "")
            .trim()
            .toLowerCase();

    if (
        typeof BAYORA_SERVICE_ICONS !== "undefined" &&
        BAYORA_SERVICE_ICONS[normalizedId]
    ) {

        return BAYORA_SERVICE_ICONS[normalizedId];

    }

    /*
     * Fallback berdasarkan judul.
     */
    const title =
        String(service?.title || "")
            .trim()
            .toLowerCase();

    const titleMap = [
        ["preset", "preset-lightroom.png"],
        ["lightroom", "preset-lightroom.png"],
        ["paket data", "paket-data.png"],
        ["pulsa", "pulsa.png"],
        ["token pln", "token-pln.png"],
        ["tagihan pln", "tagihan-pln.png"],
        ["e-wallet", "e-wallet.png"],
        ["ewallet", "e-wallet.png"],
        ["games", "games.png"],
        ["voucher game", "voucher-game.png"],
        ["voucher belanja", "voucher-belanja.png"],
        ["aktivasi voucher", "aktivasi-voucher.png"],
        ["masa aktif", "masa-aktif.png"],
        ["aktivasi perdana", "aktivasi-perdana.png"],
        ["paket sms", "paket-sms-telpon.png"],
        ["paket telpon", "paket-sms-telpon.png"],
        ["tv", "tv.png"],
        ["gas", "gas.png"],
        ["bpjs", "bpjs.png"],
        ["zakat", "zakat-donasi.png"],
        ["donasi", "zakat-donasi.png"],
        ["tiket kereta", "tiket-kereta.png"],
        ["tiket pesawat", "tiket-pesawat.png"],
        ["template media sosial", "template-media-sosial.png"],
        ["e-book", "ebook-template.png"],
        ["ebook", "ebook-template.png"],
        ["musik", "musik-digital.png"],
        ["desain", "desain-digital.png"],
        ["software", "software-tools.png"]
    ];

    for (const [keyword, icon] of titleMap) {

        if (title.includes(keyword)) {
            return icon;
        }

    }

    return null;
}


/* =========================================================
   END GLOBAL SERVICE ICON HELPER
========================================================= */



function openService(serviceId) {

    const service = services[serviceId];

    if (!service) {
        return;
    }

    console.log(
        "[BAYORA OPEN SERVICE]",
        {
            serviceId,
            title: service.title,
            type: service.type,
            productCount:
                products[serviceId]
                    ? products[serviceId].length
                    : 0
        }
    );

    currentService = serviceId;

    saveBayoraPage(
        "service:" + serviceId
    );

    try {

        sessionStorage.setItem(
            "bayora_last_service",
            serviceId
        );

    } catch (error) {

        console.warn(
            "Gagal menyimpan service terakhir.",
            error
        );

    }

    currentProduct = null;
    currentTarget = "";
    currentOperator = "";

    /*
     * Reset state digital setiap kali layanan dibuka.
     */
    selectedDigitalProducts = [];
    digitalCustomerEmail = "";
    digitalCustomerWhatsapp = "";
    selectedDigitalDevice = "";
    window.showAllDigitalProducts = false;

    document
        .getElementById("homePage")
        .classList.add("page-hidden");

    document
        .getElementById("servicePage")
        .classList.remove("page-hidden");

    document
        .getElementById("checkoutPage")
        .classList.add("page-hidden");

    document
        .getElementById("successPage")
        .classList.add("page-hidden");


    /*
     * =====================================================
     * DIGITAL PRODUCT
     * =====================================================
     *
     * Hanya produk digital yang menggunakan flow baru.
     *
     * PPOB tetap menggunakan flow lama di bawah.
     */

    const digitalFlowWrapper =
        document.getElementById(
            "digitalFlowWrapper"
        );

    if (service.type === "digital") {

        if (digitalFlowWrapper) {
            digitalFlowWrapper.style.display = "";
        }

        const formHeader =
            document.querySelector(
                "#servicePage .ppob-form-header"
            );

        if (formHeader) {
            formHeader.style.display = "none";
        }

        const digitalPanel =
            document.getElementById(
                "digitalPresetPanel"
            );

        if (digitalPanel) {
            digitalPanel.classList.remove(
                "page-hidden"
            );
        }

        /*
         * Sembunyikan form PPOB lama.
         */
        const targetGroup =
            document
                .getElementById("targetNumber")
                ?.closest(".input-group");

        const operatorGroup =
            document.getElementById(
                "operatorGroup"
            );

        const productGrid =
            document.getElementById(
                "productGrid"
            );

        const productGroup =
            productGrid
                ?.closest(".input-group");

        const price =
            document.getElementById("price");

        const priceSummary =
            price?.closest(".summary");

        const submitButton =
            document
                .getElementById("transactionForm")
                ?.querySelector(
                    'button[type="submit"]'
                );

        if (targetGroup) {
            targetGroup.style.display = "none";
        }

        if (operatorGroup) {
            operatorGroup.style.display = "none";
        }

        if (productGroup) {
            productGroup.style.display = "none";
        }

        if (priceSummary) {
            priceSummary.style.display = "none";
        }

        if (submitButton) {
            submitButton.style.display = "none";
        }


        /*
         * Header layanan.
         */
        const icon =
            document.getElementById("formIcon");

        const title =
            document.getElementById("formTitle");

        const description =
            document.getElementById(
                "formDescription"
            );

        if (icon) {
            icon.textContent =
                service.icon || "✨";
        }

        if (title) {
            title.textContent =
                service.title;
        }

        const digitalServiceIcon =
            document.querySelector(
                ".digital-form-icon"
            );

        const digitalServiceTitle =
            document.querySelector(
                ".digital-form-title"
            );

        const digitalServiceDescription =
            document.querySelector(
                ".digital-form-description"
            );

        if (digitalServiceIcon) {

            const digitalIcon =
                getBayoraServiceIcon(
                    currentService,
                    service
                );

            if (digitalIcon) {

                if (
                    String(digitalIcon).startsWith("/") ||
                    String(digitalIcon).startsWith("http://") ||
                    String(digitalIcon).startsWith("https://")
                ) {

                    digitalServiceIcon.innerHTML = `
                        <img
                            src="${String(digitalIcon).replace(/"/g, "&quot;")}"
                            alt=""
                            aria-hidden="true"
                            draggable="false"
                            style="
                                width:56px;
                                height:56px;
                                object-fit:contain;
                                display:block;
                                margin:auto;
                            "
                        >
                    `;

                } else {

                    digitalServiceIcon.innerHTML = `
                        <img
                            src="/assets/bayora-icons/${String(digitalIcon).replace(/"/g, "&quot;")}"
                            alt=""
                            aria-hidden="true"
                            draggable="false"
                            style="
                                width:56px;
                                height:56px;
                                object-fit:contain;
                                display:block;
                                margin:auto;
                            "
                        >
                    `;

                }

            } else {

                digitalServiceIcon.textContent =
                    service.icon ||
                    "✨";

            }

        }

        if (digitalServiceTitle) {
            digitalServiceTitle.textContent =
                service.title ||
                "Layanan Digital";
        }

        if (digitalServiceDescription) {
            digitalServiceDescription.textContent =
                service.description ||
                "";
        }

        if (description) {
            description.textContent =
                service.description;
        }


        /*
         * Reset kontak.
         */
        const email =
            document.getElementById(
                "digitalEmail"
            );

        const whatsapp =
            document.getElementById(
                "digitalWhatsapp"
            );

        if (email) {
            email.value = "";
        }

        if (whatsapp) {
            whatsapp.value = "";
        }


        /*
         * Reset perangkat.
         */
        document
            .querySelectorAll(
                ".digital-device-option"
            )
            .forEach(option => {
                option.classList.remove(
                    "selected"
                );
            });


        /*
         * Render katalog preset.
         */
        if (typeof renderDigitalProducts === "function") {
            renderDigitalProducts();
        }

        if (
            typeof setupDigitalBeforeAfterSliders ===
            "function"
        ) {
            setupDigitalBeforeAfterSliders();
        }

        if (
            typeof updateDigitalSelection ===
            "function"
        ) {
            updateDigitalSelection();
        }


        window.scrollTo({
            top: 0,
            behavior: "smooth"
        });

        return;
    }


    /*
     * =====================================================
     * PPOB FLOW LAMA — TIDAK DIUBAH
     * =====================================================
     */

    const formHeader =
        document.querySelector(
            "#servicePage .ppob-form-header"
        );

    if (formHeader) {
        formHeader.style.display = "";
    }

    const digitalPanel =
        document.getElementById(
            "digitalPresetPanel"
        );

    if (digitalPanel) {
        digitalPanel.classList.add(
            "page-hidden"
        );
    }

    if (digitalFlowWrapper) {
        digitalFlowWrapper.style.display = "none";
    }


    /*
     * Pastikan seluruh elemen flow digital
     * tidak memengaruhi form PPOB.
     */
    const digitalEmail =
        document.getElementById("digitalEmail");

    const digitalWhatsapp =
        document.getElementById("digitalWhatsapp");

    if (digitalEmail) {
        digitalEmail.value = "";
    }

    if (digitalWhatsapp) {
        digitalWhatsapp.value = "";
    }

    document
        .querySelectorAll(".digital-device-option")
        .forEach(option => {
            option.classList.remove("selected");
        });


    const targetGroup =
        document
            .getElementById("targetNumber")
            ?.closest(".input-group");

    const productGrid =
        document.getElementById(
            "productGrid"
        );

    const productGroup =
        productGrid
            ?.closest(".input-group");

    const price =
        document.getElementById("price");

    const priceSummary =
        price?.closest(".summary");

    const submitButton =
        document
            .getElementById("transactionForm")
            ?.querySelector(
                'button[type="submit"]'
            );

    if (targetGroup) {
        targetGroup.style.display = "";
    }

    if (productGroup) {
        productGroup.style.display = "";
    }

    if (priceSummary) {
        priceSummary.style.display = "";
    }

    if (submitButton) {
        submitButton.style.display = "";
    }


    const formIcon =
        document.getElementById("formIcon");

    if (formIcon) {

        const bayoraIcon =
            getBayoraServiceIconGlobal(
                currentService,
                service
            );

        if (bayoraIcon) {

            formIcon.innerHTML = `
                <img
                    src="${
                        String(bayoraIcon).startsWith("/") ||
                        String(bayoraIcon).startsWith("http://") ||
                        String(bayoraIcon).startsWith("https://")
                            ? bayoraIcon
                            : `/assets/bayora-icons/${bayoraIcon}`
                    }"
                    alt=""
                    aria-hidden="true"
                    draggable="false"
                    style="
                        width:56px;
                        height:56px;
                        object-fit:contain;
                        display:block;
                        margin:auto;
                    "
                >
            `;

        } else {

            formIcon.textContent =
                service.icon || "📦";

        }

    }

    document
        .getElementById("formTitle")
        .textContent = service.title;

    document
        .getElementById("formDescription")
        .textContent = service.description;

    document
        .getElementById("numberLabel")
        .textContent = service.label;

    document
        .getElementById("targetNumber")
        .placeholder = service.placeholder;

    document
        .getElementById("targetNumber")
        .value = "";


    document
        .getElementById("operatorGroup")
        .style.display =
        serviceId === "pulsa" ||
        serviceId === "data"
            ? "block"
            : "none";


    const operatorSelect =
        document.getElementById("operator");

    operatorSelect.value = "";


    // Saat operator berubah, tampilkan produk operator tersebut
    operatorSelect.onchange = function () {

        currentOperator =
            this.value.trim();

        currentProduct = null;

        document
            .getElementById("selectedProduct")
            .value = "";

        document
            .getElementById("price")
            .textContent = "Rp0";

        renderProducts();

    };


    document
        .getElementById("price")
        .textContent = "Rp0";

    document
        .getElementById("selectedProduct")
        .value = "";

    renderProducts();


    window.scrollTo({
        top: 0,
        behavior: "smooth"
    });

}

/* =========================================================
   LIGHTROOM DIGITAL PRODUCT FLOW
   Tidak mengubah flow PPOB.
========================================================= */

function getDigitalGalleryImages(product) {

    /*
     * Mendukung beberapa format:
     *
     * 1. product.previewImages = ["foto1", "foto2"]
     * 2. previewImage berisi JSON array
     * 3. previewImage berisi beberapa URL dipisahkan ||
     * 4. previewImage biasa = satu foto
     */

    if (
        Array.isArray(product.previewImages) &&
        product.previewImages.length
    ) {

        return product.previewImages
            .map(image => String(image).trim())
            .filter(Boolean);

    }


    const preview =
        String(product.previewImage || "").trim();


    if (!preview) {
        return [];
    }


    /*
     * Jika previewImage disimpan
     * sebagai JSON array.
     */
    if (
        preview.startsWith("[") &&
        preview.endsWith("]")
    ) {

        try {

            const parsed =
                JSON.parse(preview);

            if (
                Array.isArray(parsed)
            ) {

                return parsed
                    .map(image =>
                        String(image).trim()
                    )
                    .filter(Boolean);

            }

        } catch (error) {

            console.warn(
                "Preview image bukan JSON array."
            );

        }

    }


    /*
     * Beberapa gambar bisa dipisahkan
     * menggunakan ||
     */
    if (preview.includes("||")) {

        return preview
            .split("||")
            .map(image => image.trim())
            .filter(Boolean);

    }


    return [preview];

}


function renderProducts() {

    const grid =
        document.getElementById("productGrid");

    const count =
        document.getElementById("productCount");

    grid.innerHTML = "";

    let list =
        products[currentService] || [];

    // Filter produk berdasarkan operator yang dipilih
    if (currentOperator) {
        list = list.filter(product =>
            String(product.operator || "").toUpperCase() ===
            String(currentOperator || "").toUpperCase()
        );
    }

    count.textContent =
        `${list.length} produk`;


    if (
        currentService === "pln-bill" ||
        currentService === "bpjs"
    ) {

        grid.innerHTML = `

            <div class="product-empty">

                Tagihan akan dicek setelah
                nomor pelanggan dikirim
                ke provider.

            </div>

        `;

        return;
    }


    list.forEach(product => {

        const button =
            document.createElement("button");

        button.type = "button";

        button.className = "product-card";

        button.innerHTML = `

            <span class="product-card-name">
                ${product.name}
            </span>

            <span class="product-card-price">
                ${formatRupiah(product.price)}
            </span>

            <span class="product-card-info">
                ${product.info}
            </span>

        `;

        button.onclick = () => {

            selectProduct(
                button,
                product
            );

        };

        grid.appendChild(button);

    });

}


function getDigitalProducts() {

    return (
        products[currentService] || []
    ).filter(product =>
        product.productType === "digital"
    );

}


function formatDigitalProductPrice(price) {

    return formatRupiah(
        Number(price) || 0
    );

}


function renderDigitalProducts() {

    const grid =
        document.getElementById(
            "digitalProductGrid"
        );

    if (!grid) {
        return;
    }

    const allDigitalProducts =
        getDigitalProducts();

    grid.innerHTML = "";

    if (!allDigitalProducts.length) {

        grid.innerHTML = `
            <div class="product-empty">
                Belum ada preset tersedia.
            </div>
        `;

        updateDigitalSelection();

        return;
    }


    /*
     * Semua produk digital ditampilkan.
     *
     * CSS mengatur 2 kolom.
     * Produk ke-7, 8, 9, dan seterusnya
     * otomatis turun ke baris berikutnya.
     */
    allDigitalProducts.forEach(product => {

        const selected =
            selectedDigitalProducts.some(
                item => item.id === product.id
            );


        const card =
            document.createElement("article");


        card.className =
            "digital-product-card" +
            (
                selected
                    ? " selected"
                    : ""
            );


        /*
         * FOTO PRODUK
         *
         * Prioritas:
         * 1. Before + After
         * 2. Preview image
         * 3. Placeholder
         */

        const beforeImage =
            product.beforeImage || "";

        const afterImage =
            product.afterImage || "";

        const hasBeforeAfter =
            beforeImage &&
            afterImage;


        const image =
            hasBeforeAfter
                ? `
                    <div
                        class="digital-product-image digital-before-after"
                    >

                        <div
                            class="digital-before-after-track"
                        >

                            <img
                                class="
                                    digital-before-after-image
                                    digital-before-image
                                "
                                src="${beforeImage}"
                                alt="${product.name} Before"
                                loading="lazy"
                            >

                            <img
                                class="
                                    digital-before-after-image
                                    digital-after-image
                                "
                                src="${afterImage}"
                                alt="${product.name} After"
                                loading="lazy"
                            >

                        </div>

                        <div
                            class="digital-before-after-divider"
                        ></div>

                        <span
                            class="
                                digital-before-after-label
                                digital-before-label
                            "
                        >
                            BEFORE
                        </span>

                        <span
                            class="
                                digital-before-after-label
                                digital-after-label
                            "
                        >
                            AFTER
                        </span>

                        <input
                            class="
                                digital-before-after-range
                            "
                            type="range"
                            min="0"
                            max="100"
                            value="50"
                            aria-label="Geser Before After"
                        >

                    </div>
                `
                : product.previewImage
                    ? `
                        <div class="digital-product-image">

                            <img
                                src="${product.previewImage}"
                                alt="${product.name}"
                                loading="lazy"
                            >

                        </div>
                    `
                    : `
                        <div
                            class="
                                digital-product-image
                                digital-product-image-empty
                            "
                        >
                            <span>PRESET</span>
                        </div>
                    `;


        /*
         * CARD DIGITAL
         */

        card.innerHTML = `

            ${image}


            <div class="digital-product-card-body">


                <div class="digital-product-card-top">

                    <div>


                        <h4>
                            ${product.name}
                        </h4>

                    </div>


                    <strong>
                        ${formatDigitalProductPrice(product.price)}
                    </strong>

                </div>


                <p class="digital-product-info">
                    ${
                        product.mood ||
                        "Preset Lightroom"
                    }
                </p>


                <div class="digital-product-actions">

                    <button
                        type="button"
                        class="digital-detail-button"
                    >
                        Lihat Detail
                    </button>


                    <button
                        type="button"
                        class="digital-pick-button"
                    >
                        ${
                            selected
                                ? "✓ Dipilih"
                                : "Pilih"
                        }
                    </button>

                </div>


            </div>

        `;


        /*
         * DETAIL
         */

        const detailButton =
            card.querySelector(
                ".digital-detail-button"
            );


        if (detailButton) {

            detailButton.addEventListener(
                "click",
                event => {

                    event.preventDefault();
                    event.stopPropagation();

                    openDigitalProductDetail(product);

                }
            );

        }


        /*
         * PILIH PRODUK
         */

        const pickButton =
            card.querySelector(
                ".digital-pick-button"
            );


        if (pickButton) {

            pickButton.onclick = event => {

                event.stopPropagation();

                toggleDigitalProduct(
                    product
                );

            };

        }


        grid.appendChild(card);

    });


    /*
     * Update jumlah + total harga
     */

    updateDigitalSelection();

}





function setupDigitalBeforeAfterSliders() {

    const sliders =
        document.querySelectorAll(
            ".digital-before-after"
        );

    sliders.forEach(slider => {

        const range =
            slider.querySelector(
                ".digital-before-after-range"
            );

        const afterImage =
            slider.querySelector(
                ".digital-after-image"
            );

        const divider =
            slider.querySelector(
                ".digital-before-after-divider"
            );

        if (!range || !afterImage) {
            return;
        }


        /*
         * Hindari listener ganda ketika katalog
         * dirender ulang.
         */
        if (
            slider.dataset.beforeAfterReady ===
            "true"
        ) {
            return;
        }

        slider.dataset.beforeAfterReady =
            "true";


        /*
         * Update foto + posisi divider.
         *
         * 0%   = BEFORE penuh
         * 50%  = BEFORE + AFTER
         * 100% = AFTER penuh
         */
        function updateSlider(value) {

            const percentage =
                Math.max(
                    0,
                    Math.min(
                        100,
                        Number(value) || 0
                    )
                );


            const clipValue =
                `inset(0 ${100 - percentage}% 0 0)`;


            afterImage.style.setProperty(
                "clip-path",
                clipValue,
                "important"
            );

            afterImage.style.setProperty(
                "-webkit-clip-path",
                clipValue,
                "important"
            );


            if (divider) {

                divider.style.left =
                    percentage + "%";

            }


            slider.style.setProperty(
                "--before-after-position",
                percentage + "%"
            );


            range.value =
                percentage;

        }


        function updatePosition(clientX) {

            const rect =
                slider.getBoundingClientRect();

            if (!rect.width) {
                return;
            }


            const percentage =
                (
                    (clientX - rect.left) /
                    rect.width
                ) * 100;


            updateSlider(
                percentage
            );

        }


        /*
         * Posisi awal.
         */
        updateSlider(
            Number(range.value || 50)
        );


        /*
         * Tetap mendukung input range.
         */
        range.addEventListener(
            "input",
            function () {

                updateSlider(
                    this.value
                );

            }
        );


        /*
         * =====================================================
         * DESKTOP — HOVER LANGSUNG
         *
         * Mouse tidak perlu klik.
         * Posisi slider mengikuti cursor selama
         * cursor berada di atas gambar.
         * =====================================================
         */
        slider.addEventListener(
            "pointerenter",
            event => {

                if (
                    event.pointerType ===
                    "mouse"
                ) {

                    updatePosition(
                        event.clientX
                    );

                }

            }
        );


        slider.addEventListener(
            "pointermove",
            event => {

                /*
                 * Mouse:
                 * langsung mengikuti cursor.
                 */
                if (
                    event.pointerType ===
                    "mouse"
                ) {

                    updatePosition(
                        event.clientX
                    );

                    return;
                }


                /*
                 * Touch / stylus:
                 * tetap menggunakan drag/swipe.
                 */
                if (!dragging) {
                    return;
                }


                updatePosition(
                    event.clientX
                );


                event.preventDefault();

            },
            {
                passive: false
            }
        );


        /*
         * =====================================================
         * MOBILE / TABLET — DRAG / SWIPE
         * =====================================================
         */
        let dragging = false;


        slider.addEventListener(
            "pointerdown",
            event => {

                /*
                 * Mouse tidak membutuhkan
                 * mode dragging karena hover
                 * sudah aktif.
                 */
                if (
                    event.pointerType ===
                    "mouse"
                ) {

                    updatePosition(
                        event.clientX
                    );

                    return;

                }


                dragging = true;


                slider.setPointerCapture?.(
                    event.pointerId
                );


                updatePosition(
                    event.clientX
                );


                event.preventDefault();

            },
            {
                passive: false
            }
        );


        function stopDragging(event) {

            if (!dragging) {
                return;
            }


            dragging = false;


            try {

                slider.releasePointerCapture?.(
                    event.pointerId
                );

            } catch (error) {
                /* aman diabaikan */
            }

        }


        slider.addEventListener(
            "pointerup",
            stopDragging
        );


        slider.addEventListener(
            "pointercancel",
            stopDragging
        );


        slider.addEventListener(
            "lostpointercapture",
            () => {

                dragging = false;

            }
        );

    });

}


function toggleDigitalProduct(product) {

    const index =
        selectedDigitalProducts.findIndex(
            item => item.id === product.id
        );


    if (index >= 0) {

        selectedDigitalProducts.splice(
            index,
            1
        );

    } else {

        selectedDigitalProducts.push(
            product
        );

    }


    renderDigitalProducts();

}


function selectAllDigitalProducts() {

    const list =
        getDigitalProducts();

    if (list.length <= 4) {
        return;
    }

    window.showAllDigitalProducts =
        !window.showAllDigitalProducts;

    renderDigitalProducts();

}


function updateDigitalSelection() {

    const count =
        document.getElementById(
            "digitalSelectedCount"
        );

    const total =
        document.getElementById(
            "digitalSelectedTotal"
        );

    const selectAll =
        document.getElementById(
            "selectAllDigitalProducts"
        );


    const selectedCount =
        selectedDigitalProducts.length;


    const selectedTotal =
        selectedDigitalProducts.reduce(
            (sum, product) =>
                sum +
                (
                    Number(product.price) || 0
                ),
            0
        );


    if (count) {

        count.textContent =
            `${selectedCount} preset dipilih`;

    }


    if (total) {

        total.textContent =
            formatDigitalProductPrice(
                selectedTotal
            );

    }


    if (selectAll) {

        const list =
            getDigitalProducts();

        selectAll.textContent =
            list.length &&
            selectedCount === list.length
                ? "Batalkan Semua"
                : "Pilih Semua";

    }

}


function setupDigitalProductFlow() {

    const selectAll =
        document.getElementById(
            "selectAllDigitalProducts"
        );


    if (selectAll) {

        selectAll.onclick =
            selectAllDigitalProducts;

    }


    document
        .querySelectorAll(
            ".digital-device-option"
        )
        .forEach(option => {

            option.onclick = () => {

                selectedDigitalDevice =
                    option.dataset.device ||
                    "";


                document
                    .querySelectorAll(
                        ".digital-device-option"
                    )
                    .forEach(item => {

                        item.classList.remove(
                            "selected"
                        );

                    });


                option.classList.add(
                    "selected"
                );

            };

        });


    const continueButton =
        document.getElementById(
            "digitalContinueButton"
        );


    if (continueButton) {

        continueButton.onclick =
            goToDigitalCheckout;

    }


    /*
     * Validasi email + WhatsApp
     * dilakukan ketika lanjut ke review.
     */

}


function selectProduct(
    button,
    product
) {

    currentProduct = product;

    document
        .querySelectorAll(".product-card")
        .forEach(item => {

            item.classList.remove("selected");

        });

    button.classList.add("selected");

    document
        .getElementById("selectedProduct")
        .value = product.id;

    document
        .getElementById("price")
        .textContent =
        formatRupiah(product.price);

}


function goToCheckout(event) {

    event.preventDefault();

    currentTarget =
        document
            .getElementById("targetNumber")
            .value
            .trim();

    currentOperator =
        document
            .getElementById("operator")
            .value;


    if (!currentTarget) {

        alert(
            "Silakan masukkan tujuan transaksi."
        );

        return;

    }


    if (
        currentService === "pulsa" ||
        currentService === "data"
    ) {

        if (!currentOperator) {

            alert(
                "Silakan pilih operator."
            );

            return;

        }

    }


    if (
        currentService !== "pln-bill" &&
        currentService !== "bpjs"
    ) {

        if (!currentProduct) {

            alert(
                "Silakan pilih produk."
            );

            return;

        }

    }


    renderCheckout();

    saveBayoraPage("checkout");

    document
        .getElementById("servicePage")
        .classList.add("page-hidden");

    document
        .getElementById("checkoutPage")
        .classList.remove("page-hidden");

    window.scrollTo({
        top: 0,
        behavior: "smooth"
    });

}


function renderCheckout() {

    const service =
        services[currentService];

    let productRow = "";

    let price = 0;


    if (currentProduct) {

        price =
            currentProduct.price;

        productRow = `

            <div class="checkout-row">

                <span>
                    Produk
                </span>

                <strong>
                    ${currentProduct.name}
                </strong>

            </div>

        `;

    }


    let operatorRow = "";


    if (
        currentService === "pulsa" ||
        currentService === "data"
    ) {

        operatorRow = `

            <div class="checkout-row">

                <span>
                    Operator
                </span>

                <strong>
                    ${currentOperator}
                </strong>

            </div>

        `;

    }


    document
        .getElementById("checkoutSummary")
        .innerHTML = `

            <div class="checkout-row">

                <span>
                    Layanan
                </span>

                <strong>
                    ${service.icon}
                    ${service.title}
                </strong>

            </div>


            <div class="checkout-row">

                <span>
                    Tujuan
                </span>

                <strong>
                    ${currentTarget}
                </strong>

            </div>


            ${operatorRow}

            ${productRow}


            <div class="
                checkout-row
                checkout-total
            ">

                <span>
                    Total pembayaran
                </span>

                <strong>
                    ${
                        price
                            ? formatRupiah(price)
                            : "Akan dicek"
                    }
                </strong>

            </div>

        `;

}


function backToService() {

    document
        .getElementById("checkoutPage")
        .classList.add("page-hidden");

    document
        .getElementById("servicePage")
        .classList.remove("page-hidden");

    window.scrollTo({
        top: 0,
        behavior: "smooth"
    });

}







function renderDigitalGallery() {

    const gallery =
        document.getElementById(
            "digitalDetailGallery"
        );

    if (!gallery) {
        return;
    }


    gallery.innerHTML = "";


    if (
        !Array.isArray(
            digitalGalleryImages
        ) ||
        !digitalGalleryImages.length
    ) {

        gallery.innerHTML = `
            <div class="digital-detail-gallery-empty">
                Preview produk belum tersedia.
            </div>
        `;

        return;
    }


    const image =
        document.createElement("img");

    image.src =
        digitalGalleryImages[
            digitalGalleryIndex
        ];

    image.alt =
        "Preview produk";

    image.loading = "eager";


    gallery.appendChild(
        image
    );


    /*
     * NAVIGASI GALLERY
     */

    if (
        digitalGalleryImages.length > 1
    ) {

        const previous =
            document.createElement(
                "button"
            );

        previous.type = "button";

        previous.className =
            "digital-gallery-nav digital-gallery-prev";

        previous.innerHTML = "‹";

        previous.setAttribute(
            "aria-label",
            "Gambar sebelumnya"
        );


        previous.onclick = event => {

            event.preventDefault();
            event.stopPropagation();

            digitalGalleryIndex =
                (
                    digitalGalleryIndex -
                    1 +
                    digitalGalleryImages.length
                ) %
                digitalGalleryImages.length;

            renderDigitalGallery();

        };


        const next =
            document.createElement(
                "button"
            );

        next.type = "button";

        next.className =
            "digital-gallery-nav digital-gallery-next";

        next.innerHTML = "›";

        next.setAttribute(
            "aria-label",
            "Gambar berikutnya"
        );


        next.onclick = event => {

            event.preventDefault();
            event.stopPropagation();

            digitalGalleryIndex =
                (
                    digitalGalleryIndex +
                    1
                ) %
                digitalGalleryImages.length;

            renderDigitalGallery();

        };


        gallery.appendChild(
            previous
        );

        gallery.appendChild(
            next
        );


        const indicator =
            document.createElement(
                "div"
            );

        indicator.className =
            "digital-gallery-indicator";

        indicator.textContent =
            `${digitalGalleryIndex + 1} / ${digitalGalleryImages.length}`;

        gallery.appendChild(
            indicator
        );

    }

}



function openDigitalProductDetail(product) {

    const modal =
        document.getElementById(
            "digitalProductDetailModal"
        );

    if (!modal) {
        return;
    }


    window.currentDigitalDetailProduct =
        product;


    const name =
        document.getElementById(
            "digitalDetailName"
        );

    const price =
        document.getElementById(
            "digitalDetailPrice"
        );

    const description =
        document.getElementById(
            "digitalDetailDescription"
        );

    const gallery =
        document.getElementById(
            "digitalDetailGallery"
        );


    if (name) {
        name.textContent =
            product.name;
    }


    if (price) {
        price.textContent =
            formatDigitalProductPrice(
                product.price
            );
    }


    if (description) {

        description.textContent =
            product.info ||
            "Preset Lightroom digital yang siap digunakan.";

    }


    /*
     * DETAIL GALLERY
     * Menggunakan galleryImages yang berasal
     * dari database produk.
     */
    digitalGalleryImages =
        Array.isArray(product.galleryImages)
            ? product.galleryImages.filter(Boolean)
            : [];

    /*
     * Fallback ke preview lama jika gallery
     * belum tersedia.
     */
    if (!digitalGalleryImages.length) {

        digitalGalleryImages =
            getDigitalGalleryImages(product);

    }

    digitalGalleryIndex = 0;

    window.currentDigitalDetailProduct =
        product;

    renderDigitalGallery();


    const selectButton =
        document.getElementById(
            "digitalDetailSelectButton"
        );


    if (selectButton) {

        const alreadySelected =
            selectedDigitalProducts.some(
                item =>
                    item.id === product.id
            );


        selectButton.textContent =
            alreadySelected
                ? "✓ Preset Dipilih"
                : "Pilih Preset";


        selectButton.onclick = () => {

            const alreadySelected =
                selectedDigitalProducts.some(
                    item =>
                        item.id === product.id
                );

            /*
             * Dari detail, tombol ini hanya digunakan
             * untuk memilih preset.
             *
             * Jika belum dipilih:
             * pilih preset lalu kembali ke katalog.
             */
            if (!alreadySelected) {

                toggleDigitalProduct(
                    product
                );

                closeDigitalProductDetail();

                return;

            }

            /*
             * Jika preset sudah dipilih,
             * jangan batalkan pilihan dari halaman detail.
             * Cukup kembali ke katalog.
             */
            closeDigitalProductDetail();

        };

    }


    modal.classList.remove(
        "page-hidden"
    );

    modal.classList.add(
        "digital-detail-open"
    );

    document.body.style.overflow =
        "hidden";

}


function closeDigitalProductDetail() {

    const modal =
        document.getElementById(
            "digitalProductDetailModal"
        );

    if (modal) {

        modal.classList.remove(
            "digital-detail-open"
        );

        modal.classList.add(
            "page-hidden"
        );

    }


    document.body.style.overflow =
        "";

}



function renderDigitalCheckout() {

    const summary =
        document.getElementById(
            "checkoutSummary"
        );

    if (!summary) {
        console.error(
            "[BAYORA] checkoutSummary tidak ditemukan."
        );
        return;
    }


    const total =
        selectedDigitalProducts.reduce(
            (sum, product) =>
                sum +
                (
                    Number(product.price) || 0
                ),
            0
        );


    const productRows =
        selectedDigitalProducts
            .map(product => `
                <div class="checkout-row">

                    <span>
                        ${product.name}
                    </span>

                    <strong>
                        ${formatDigitalProductPrice(
                            product.price
                        )}
                    </strong>

                </div>
            `)
            .join("");


    summary.innerHTML = `

        <div class="checkout-row">

            <span>
                Produk
            </span>

            <strong>
                ${selectedDigitalProducts.length}
                preset
            </strong>

        </div>


        ${productRows}


        <div class="checkout-row">

            <span>
                Perangkat
            </span>

            <strong>
                ${selectedDigitalDevice}
            </strong>

        </div>


        <div class="checkout-row">

            <span>
                Email
            </span>

            <strong>
                ${digitalCustomerEmail}
            </strong>

        </div>


        <div class="checkout-row">

            <span>
                WhatsApp
            </span>

            <strong>
                ${digitalCustomerWhatsapp}
            </strong>

        </div>


        <div class="
            checkout-row
            checkout-total
        ">

            <span>
                Total pembayaran
            </span>

            <strong>
                ${formatDigitalProductPrice(total)}
            </strong>

        </div>

    `;

}



function goToDigitalCheckout() {

    const email =
        document.getElementById(
            "digitalEmail"
        );

    const whatsapp =
        document.getElementById(
            "digitalWhatsapp"
        );


    digitalCustomerEmail =
        email
            ? email.value.trim()
            : "";


    digitalCustomerWhatsapp =
        whatsapp
            ? whatsapp.value.trim()
            : "";


    if (!digitalCustomerEmail) {

        alert(
            "Silakan masukkan email."
        );

        email?.focus();

        return;

    }


    if (
        !digitalCustomerEmail.includes("@") ||
        !digitalCustomerEmail.includes(".")
    ) {

        alert(
            "Silakan masukkan email yang valid."
        );

        email?.focus();

        return;

    }


    if (!digitalCustomerWhatsapp) {

        alert(
            "Silakan masukkan nomor WhatsApp."
        );

        whatsapp?.focus();

        return;

    }


    if (!selectedDigitalProducts.length) {

        alert(
            "Silakan pilih minimal satu preset."
        );

        return;

    }


    if (!selectedDigitalDevice) {

        alert(
            "Silakan pilih perangkat."
        );

        return;

    }


    renderDigitalCheckout();

    saveBayoraPage("checkout");

    document
        .getElementById("servicePage")
        .classList.add(
            "page-hidden"
        );


    document
        .getElementById("checkoutPage")
        .classList.remove(
            "page-hidden"
        );


    window.scrollTo({
        top: 0,
        behavior: "smooth"
    });

}


async function processDigitalPayment() {

    const button =
        document.querySelector(
            "#checkoutPage .submit-button"
        );

    if (!button) {
        alert("Tombol pembayaran tidak ditemukan.");
        return;
    }

    const originalText =
        button.textContent;

    button.disabled = true;
    button.textContent =
        "Membuat pesanan...";

    try {

        /*
         * Kirim hanya ID produk.
         * Harga akan diverifikasi ulang
         * oleh server dari database.
         */
        const response =
            await fetch(
                "/api/digital-transactions",
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body: JSON.stringify({

                        service:
                            currentService,

                        productIds:
                            selectedDigitalProducts.map(
                                product => product.id
                            ),

                        customerEmail:
                            digitalCustomerEmail,

                        customerWhatsapp:
                            digitalCustomerWhatsapp,

                        device:
                            selectedDigitalDevice,

                        paymentMethod:
                            "xendit"

                    })
                }
            );

        const data =
            await response.json();

        if (!response.ok || !data.success) {

            throw new Error(
                data.error ||
                "Gagal membuat transaksi digital."
            );

        }

        const transaction =
            data.transaction;

        button.textContent =
            "Membuka pembayaran...";

        /*
         * Gunakan endpoint khusus Xendit
         * untuk transaksi produk digital.
         */
        const xenditResponse =
            await fetch(
                "/api/payments/xendit-digital",
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body: JSON.stringify({

                        transactionId:
                            transaction.transactionId,

                        customerEmail:
                            digitalCustomerEmail,

                        customerWhatsapp:
                            digitalCustomerWhatsapp

                    })
                }
            );

        const xenditData =
            await xenditResponse.json();

        if (
            !xenditResponse.ok ||
            !xenditData.success ||
            !xenditData.paymentUrl
        ) {

            throw new Error(
                xenditData.error ||
                "Gagal membuat pembayaran Xendit."
            );

        }

        window.location.href =
            xenditData.paymentUrl;

    } catch (error) {

        console.error(
            "Digital payment error:",
            error
        );

        alert(
            error.message ||
            "Gagal memproses pembayaran."
        );

        button.disabled = false;

        button.textContent =
            originalText;

    }

}


async function processPayment() {

    /*
     * =====================================================
     * DIGITAL PRODUCT PAYMENT
     * =====================================================
     *
     * Lightroom / preset menggunakan transaksi
     * digital multi-produk.
     *
     * Flow PPOB di bawah TIDAK DIUBAH.
     */

    const service =
        services[currentService];

    if (
        service &&
        service.type === "digital"
    ) {

        await processDigitalPayment();

        return;
    }


    // Pembayaran PPOB menggunakan Xendit secara otomatis.
    const payment = "xendit";


    if (!service) {

        alert(
            "Layanan tidak ditemukan."
        );

        return;

    }


    if (
        currentService !== "pln-bill" &&
        currentService !== "bpjs" &&
        !currentProduct
    ) {

        alert(
            "Produk belum dipilih."
        );

        return;

    }


    const button =
        document.querySelector(
            "#checkoutPage .submit-button"
        );


    const originalText =
        button.textContent;


    button.disabled = true;

    button.textContent =
        "Membuat transaksi...";


    try {

        const response =
            await fetch(
                "/api/transactions",
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body: JSON.stringify({

                        service:
                            currentService,

                        target:
                            currentTarget,

                        operator:
                            currentOperator || null,

                        productId:
                            currentProduct
                                ? currentProduct.id
                                : null,

                        productName:
                            currentProduct
                                ? currentProduct.name
                                : service.title,

                        price:
                            currentProduct
                                ? currentProduct.price
                                : 0,

                        paymentMethod:
                            payment

                    })
                }
            );


        const data =
            await response.json();


        if (!response.ok) {

            throw new Error(
                data.error ||
                "Gagal membuat transaksi."
            );

        }


        const transaction =
            data.transaction;


        // Semua metode pembayaran diarahkan ke checkout Xendit
        button.textContent =
            "Membuka pembayaran...";

        const xenditResponse =
            await fetch(
                "/api/payments/xendit",
                {
                    method: "POST",

                    headers: {
                        "Content-Type":
                            "application/json"
                    },

                    body: JSON.stringify({
                        transactionId:
                            transaction.transactionId,

                        customerEmail:
                            "customer@example.com",

                        customerName:
                            "Pelanggan PPOBKU"
                    })
                }
            );

        const xenditData =
            await xenditResponse.json();

        if (!xenditResponse.ok ||
            !xenditData.success ||
            !xenditData.paymentUrl) {

            throw new Error(
                xenditData.error ||
                "Gagal membuat pembayaran Xendit."
            );

        }

        window.location.href =
            xenditData.paymentUrl;

        return;


        document
            .getElementById("checkoutPage")
            .classList.add("page-hidden");

        document
            .getElementById("successPage")
            .classList.remove("page-hidden");


        document
            .getElementById("orderSummary")
            .innerHTML = `

                <div class="checkout-row">

                    <span>
                        Nomor transaksi
                    </span>

                    <strong>
                        ${transaction.id}
                    </strong>

                </div>


                <div class="checkout-row">

                    <span>
                        Referensi
                    </span>

                    <strong>
                        ${transaction.reference}
                    </strong>

                </div>


                <div class="checkout-row">

                    <span>
                        Layanan
                    </span>

                    <strong>
                        ${service.icon}
                        ${service.title}
                    </strong>

                </div>


                <div class="checkout-row">

                    <span>
                        Tujuan
                    </span>

                    <strong>
                        ${currentTarget}
                    </strong>

                </div>


                ${
                    currentProduct
                        ? `

                            <div class="checkout-row">

                                <span>
                                    Produk
                                </span>

                                <strong>
                                    ${currentProduct.name}
                                </strong>

                            </div>

                        `
                        : ""
                }


                <div class="checkout-row">

                    <span>
                        Pembayaran
                    </span>

                    <strong>
                        ${getPaymentName(payment)}
                    </strong>

                </div>


                <div class="checkout-row">

                    <span>
                        Status
                    </span>

                    <strong id="transactionStatus">
                        MENUNGGU PEMBAYARAN
                    </strong>

                </div>


                <div class="
                    checkout-row
                    checkout-total
                ">

                    <span>
                        Total
                    </span>

                    <strong>
                        ${
                            transaction.price
                                ? formatRupiah(
                                    transaction.price
                                )
                                : "Akan dicek"
                        }
                    </strong>

                </div>

            `;


        checkTransactionStatus(transaction.transactionId);

        window.scrollTo({
            top: 0,
            behavior: "smooth"
        });


    } catch (error) {

        console.error(
            "Transaction error:",
            error
        );

        alert(
            "Gagal membuat transaksi:\n" +
            error.message
        );


    } finally {

        button.disabled = false;

        button.textContent =
            originalText;

    }

}


function showDigitalDownloadButton(
    transactionId,
    productName,
    downloadToken
) {

    const successPage =
        document.getElementById("successPage");

    if (!successPage) {
        console.warn(
            "[DIGITAL DOWNLOAD] successPage tidak ditemukan."
        );
        return;
    }

    /*
     * =====================================================
     * BAYORA — DIGITAL SUCCESS
     * REFERENSI:
     * Konfirmasi Pesanan Digital BAYORA
     *
     * Layout dibuat mengikuti tampilan email:
     * MAIN CARD + SIDEBAR
     * MOBILE = SINGLE COLUMN
     * =====================================================
     */

    let successBox =
        successPage.querySelector(".success-box");

    if (!successBox) {
        return;
    }

    /*
     * Ambil transaksi terbaru agar halaman
     * mempunyai data yang sama dengan email.
     */
    fetch(
        `/api/transactions/${encodeURIComponent(transactionId)}`
    )
    .then(response => response.json())
    .then(data => {

        if (
            !data ||
            !data.success ||
            !data.transaction
        ) {
            throw new Error(
                "Data transaksi tidak ditemukan."
            );
        }

        const transaction =
            data.transaction;

        /*
         * =================================================
         * DATA
         * =================================================
         */

        const email =
            transaction.target ||
            "email kamu";

        const transactionDate =
            transaction.createdAt
                ? new Date(
                    transaction.createdAt
                ).toLocaleString(
                    "id-ID",
                    {
                        day: "2-digit",
                        month: "long",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false
                    }
                ) + " WIB"
                : "-";

        const paymentMethod =
            transaction.paymentMethod === "xendit"
                ? "Xendit"
                : (
                    transaction.paymentMethod ||
                    "-"
                );

        const paymentStatus =
            transaction.paymentStatus === "PAID"
                ? "Berhasil"
                : transaction.paymentStatus;

        const total =
            Number(
                transaction.price || 0
            ).toLocaleString(
                "id-ID"
            );

        /*
         * =================================================
         * BERSIHKAN DOWNLOAD LAMA
         * =================================================
         */

        const old =
            document.getElementById(
                "bayoraDigitalSuccessLayout"
            );

        if (old) {
            old.remove();
        }

        /*
         * =================================================
         * STYLE
         * =================================================
         */

        const styleId =
            "bayoraDigitalSuccessEmailStyle";

        const oldStyle =
            document.getElementById(styleId);

        if (oldStyle) {
            oldStyle.remove();
        }

        const style =
            document.createElement("style");

        style.id = styleId;

        style.textContent = `

            #successPage.bayora-digital-success {
                display: block !important;
                width: 100% !important;
                box-sizing: border-box !important;
                padding: 42px 5% 70px !important;
                background: #f5f9ff !important;
            }

            #bayoraDigitalSuccessLayout {
                width: 100%;
                max-width: 1100px;
                margin: 0 auto;
                display: grid;
                grid-template-columns:
                    minmax(0, 1fr)
                    280px;
                gap: 24px;
                align-items: start;
                box-sizing: border-box;
            }

            #bayoraDigitalMainCard {
                width: 100%;
                min-width: 0;
                box-sizing: border-box;
                background: #ffffff;
                border: 1px solid #e1ebf7;
                border-radius: 18px;
                padding: 30px;
                box-shadow:
                    0 18px 45px
                    rgba(23,70,130,.08);
            }

            #bayoraDigitalSuccessLayout
            .bayora-success-icon {
                width: 62px;
                height: 62px;
                margin: 0 auto 12px;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                background:
                    linear-gradient(
                        135deg,
                        #1769ff,
                        #16c7ff
                    );
                color: #ffffff;
                font-size: 28px;
                box-shadow:
                    0 12px 28px
                    rgba(23,105,255,.22);
            }

            #bayoraDigitalSuccessLayout
            .bayora-demo {
                width: fit-content;
                margin: 0 auto 16px;
                padding: 6px 14px;
                border-radius: 999px;
                background: #f1f6ff;
                border: 1px solid #d7e5ff;
                color: #1769ff;
                font-size: 11px;
                font-weight: 800;
                letter-spacing: 2px;
            }

            #bayoraDigitalSuccessLayout
            .bayora-success-title {
                margin: 0;
                padding-top: 0;
                text-align: center;
                color: #16264b;
                font-size: 34px;
                line-height: 1.15;
                letter-spacing: -1px;
                font-weight: 800;
            }

            #bayoraDigitalSuccessLayout
            .bayora-success-description {
                max-width: 620px;
                margin: 16px auto 28px;
                text-align: center;
                color: #64748b;
                font-size: 15px;
                line-height: 1.65;
            }

            #bayoraDigitalSuccessLayout
            .bayora-divider {
                height: 1px;
                background: #e5edf7;
                margin: 0 0 26px;
            }

            #bayoraDigitalSuccessLayout
            .bayora-section-title {
                margin: 0 0 8px;
                color: #16264b;
                font-size: 13px;
                font-weight: 800;
                letter-spacing: .5px;
            }

            #bayoraDigitalSuccessLayout
            .bayora-section-description {
                margin: 0 0 14px;
                color: #64748b;
                font-size: 13px;
                line-height: 1.5;
            }

            #bayoraDigitalSuccessLayout
            .bayora-summary {
                padding: 0 0 25px;
                margin-bottom: 25px;
                border-bottom: 1px solid #e5edf7;
            }

            #bayoraDigitalSuccessLayout
            .bayora-summary-row {
                display: flex;
                justify-content: space-between;
                gap: 20px;
                padding: 7px 0;
                color: #344563;
                font-size: 13px;
                line-height: 1.5;
            }

            #bayoraDigitalSuccessLayout
            .bayora-summary-value {
                text-align: right;
                color: #16264b;
                font-weight: 700;
                overflow-wrap: anywhere;
            }

            #bayoraDigitalSuccessLayout
            .bayora-paid {
                display: inline-flex;
                padding: 4px 9px;
                border-radius: 999px;
                background: #e7f8ec;
                color: #159447;
                font-size: 11px;
                font-weight: 800;
            }

            #bayoraDigitalSuccessLayout
            .bayora-downloads {
                display: flex;
                flex-direction: column;
                gap: 10px;
            }

            #bayoraDigitalSuccessLayout
            .bayora-download-item {
                display: flex;
                align-items: center;
                gap: 14px;
                width: 100%;
                min-width: 0;
                box-sizing: border-box;
                padding: 12px;
                border: 1px solid #e1eaf5;
                border-radius: 12px;
                background: #ffffff;
                box-shadow:
                    0 7px 18px
                    rgba(23,70,130,.05);
            }

            #bayoraDigitalSuccessLayout
            .bayora-file-icon {
                width: 46px;
                height: 46px;
                flex: 0 0 46px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 10px;
                background:
                    linear-gradient(
                        135deg,
                        #1769ff,
                        #16c7ff
                    );
                color: #ffffff;
                font-size: 10px;
                font-weight: 900;
                box-shadow:
                    0 7px 16px
                    rgba(23,105,255,.18);
            }

            #bayoraDigitalSuccessLayout
            .bayora-file-info {
                flex: 1;
                min-width: 0;
            }

            #bayoraDigitalSuccessLayout
            .bayora-file-title {
                color: #16264b;
                font-size: 13px;
                font-weight: 800;
                line-height: 1.35;
            }

            #bayoraDigitalSuccessLayout
            .bayora-file-meta {
                margin-top: 3px;
                color: #64748b;
                font-size: 11px;
                line-height: 1.45;
            }

            #bayoraDigitalSuccessLayout
            .bayora-download-button {
                flex: 0 0 auto;
                display: inline-flex;
                align-items: center;
                justify-content: center;
                gap: 6px;
                min-width: 100px;
                padding: 9px 13px;
                border-radius: 9px;
                border: 1px solid #8ab4ff;
                background: #ffffff;
                color: #1769ff;
                text-decoration: none;
                font-size: 11px;
                font-weight: 800;
                box-sizing: border-box;
            }

            #bayoraDigitalSuccessLayout
            .bayora-email-notice {
                margin-top: 14px;
                padding: 13px 14px;
                border: 1px solid #f3d889;
                border-left: 4px solid #ffc928;
                border-radius: 10px;
                background: #fffdf5;
                color: #344563;
                font-size: 12px;
                line-height: 1.55;
            }

            #bayoraDigitalSuccessLayout
            .bayora-email-notice strong {
                color: #16264b;
            }

            #bayoraDigitalSuccessLayout
            .bayora-home-button {
                width: 100%;
                margin-top: 20px;
                padding: 13px 18px;
                border: 0;
                border-radius: 9px;
                background:
                    linear-gradient(
                        100deg,
                        #1769ff,
                        #16c7ff
                    );
                color: #ffffff;
                font-size: 13px;
                font-weight: 800;
                cursor: pointer;
                box-shadow:
                    0 10px 22px
                    rgba(23,105,255,.18);
            }

            #bayoraDigitalSidebar {
                display: flex;
                flex-direction: column;
                gap: 20px;
                min-width: 0;
            }

            #bayoraDigitalSidebar
            .bayora-side-card {
                padding: 24px 20px;
                background: #ffffff;
                border: 1px solid #e1ebf7;
                border-radius: 14px;
                box-shadow:
                    0 14px 32px
                    rgba(23,70,130,.07);
                text-align: center;
            }

            #bayoraDigitalSidebar
            .bayora-side-title {
                margin: 0 0 18px;
                color: #16264b;
                font-size: 12px;
                font-weight: 800;
            }

            #bayoraDigitalSidebar
            .bayora-side-icon {
                width: 48px;
                height: 48px;
                margin: 0 auto 14px;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                background: #eef5ff;
                color: #1769ff;
                font-size: 21px;
            }

            #bayoraDigitalSidebar
            .bayora-side-text {
                margin: 0;
                color: #64748b;
                font-size: 12px;
                line-height: 1.7;
            }

            #bayoraDigitalSidebar
            .bayora-contact {
                display: inline-flex;
                align-items: center;
                justify-content: center;
                margin-top: 14px;
                padding: 9px 13px;
                border-radius: 999px;
                background: #f1f6ff;
                border: 1px solid #d8e6ff;
                color: #1769ff;
                font-size: 11px;
                font-weight: 800;
            }

            #bayoraDigitalSidebar
            .bayora-security-list {
                margin: 0;
                padding: 0;
                list-style: none;
                text-align: left;
            }

            #bayoraDigitalSidebar
            .bayora-security-list li {
                position: relative;
                padding-left: 18px;
                margin: 10px 0;
                color: #52627d;
                font-size: 11px;
                line-height: 1.5;
            }

            #bayoraDigitalSidebar
            .bayora-security-list li::before {
                content: "✓";
                position: absolute;
                left: 0;
                color: #1769ff;
                font-weight: 900;
            }

            #bayoraDigitalSidebar
            .bayora-side-brand {
                margin-top: 18px;
                color: #1769ff;
                font-size: 14px;
                font-weight: 900;
            }

            @media (max-width: 760px) {

                #successPage.bayora-digital-success {
                    padding:
                        24px 14px 45px !important;
                }

                #bayoraDigitalSuccessLayout {
                    grid-template-columns: 1fr;
                    gap: 16px;
                }

                #bayoraDigitalMainCard {
                    padding: 22px 16px;
                    border-radius: 18px;
                }

                #bayoraDigitalSuccessLayout
                .bayora-success-title {
                    font-size: 30px;
                }

                #bayoraDigitalSuccessLayout
                .bayora-success-description {
                    font-size: 14px;
                }

                #bayoraDigitalSuccessLayout
                .bayora-summary-row {
                    align-items: flex-start;
                }

                #bayoraDigitalSuccessLayout
                .bayora-download-item {
                    align-items: flex-start;
                    flex-wrap: wrap;
                }

                #bayoraDigitalSuccessLayout
                .bayora-download-button {
                    width: 100%;
                    flex-basis: 100%;
                }

                #bayoraDigitalSidebar {
                    width: 100%;
                }
            }

        `;

        document.head.appendChild(style);

        /*
         * =================================================
         * BUILD MAIN CARD
         * =================================================
         */

        const layout =
            document.createElement("div");

        layout.id =
            "bayoraDigitalSuccessLayout";

        const main =
            document.createElement("div");

        main.id =
            "bayoraDigitalMainCard";

        const icon =
            document.createElement("div");

        icon.className =
            "bayora-success-icon";

        icon.textContent =
            "✓";

        const demo =
            document.createElement("div");

        demo.className =
            "bayora-demo";

        demo.textContent =
            "";

        /*
         * DEMO hanya mengikuti referensi email.
         * Tidak mengubah status transaksi.
         */

        const title =
            document.createElement("h2");

        title.className =
            "bayora-success-title";

        title.textContent =
            "Pesanan diterima";

        const description =
            document.createElement("p");

        description.className =
            "bayora-success-description";

        description.innerHTML =
            "Pembayaran berhasil. Terima kasih " +
            "telah berbelanja di BAYORA.<br>" +
            "Detail pesanan Anda tersedia di bawah ini.";

        const divider =
            document.createElement("div");

        divider.className =
            "bayora-divider";

        /*
         * =================================================
         * RINGKASAN PESANAN
         * =================================================
         */

        const summary =
            document.createElement("section");

        summary.className =
            "bayora-summary";

        summary.innerHTML = `
            <h3 class="bayora-section-title">
                RINGKASAN PESANAN
            </h3>

            <div class="bayora-summary-row">
                <span>ID Transaksi</span>
                <span class="bayora-summary-value">
                    ${transaction.transactionId || transactionId}
                </span>
            </div>

            <div class="bayora-summary-row">
                <span>Tanggal</span>
                <span class="bayora-summary-value">
                    ${transactionDate}
                </span>
            </div>

            <div class="bayora-summary-row">
                <span>Metode Pembayaran</span>
                <span class="bayora-summary-value">
                    ${paymentMethod}
                </span>
            </div>

            <div class="bayora-summary-row">
                <span>Status Pembayaran</span>
                <span class="bayora-summary-value">
                    <span class="bayora-paid">
                        ${paymentStatus}
                    </span>
                </span>
            </div>

            <div class="bayora-summary-row">
                <span>Total Pembayaran</span>
                <span class="bayora-summary-value">
                    Rp${total}
                </span>
            </div>
        `;

        /*
         * =================================================
         * FILE PESANAN
         * =================================================
         */

        const filesSection =
            document.createElement("section");

        filesSection.innerHTML = `
            <h3 class="bayora-section-title">
                FILE PESANAN
            </h3>

            <p class="bayora-section-description">
                File produk digital yang Anda beli:
            </p>
        `;

        const downloads =
            document.createElement("div");

        downloads.className =
            "bayora-downloads";

        const preset =
            document.createElement("div");

        preset.className =
            "bayora-download-item";

        preset.innerHTML = `
            <div class="bayora-file-icon">
                ZIP
            </div>

            <div class="bayora-file-info">
                <div class="bayora-file-title">
                    Download Preset
                </div>

                <div class="bayora-file-meta">
                    File ZIP<br>
                    Lightroom Preset
                </div>
            </div>
        `;

        const presetLink =
            document.createElement("a");

        presetLink.className =
            "bayora-download-button";

        presetLink.href =
            `/api/digital-products/download/${encodeURIComponent(
                transactionId
            )}`;

        presetLink.dataset.downloadUrl =
            presetLink.href;

        presetLink.removeAttribute("target");
        presetLink.removeAttribute("rel");

        presetLink.innerHTML =
            "↓&nbsp; Download";

        presetLink.addEventListener(
            "click",
            async event => {

                event.preventDefault();

                if (!downloadToken) {

                    alert(
                        "Token download tidak tersedia. Silakan muat ulang halaman."
                    );

                    return;
                }

                const originalText =
                    presetLink.innerHTML;

                presetLink.innerHTML =
                    "MENYIAPKAN DOWNLOAD...";

                try {

                    const response =
                        await fetch(
                            presetLink.dataset.downloadUrl,
                            {
                                method: "GET",
                                headers: {
                                    Authorization:
                                        "Bearer " +
                                        downloadToken
                                },
                                cache: "no-store"
                            }
                        );

                    if (!response.ok) {

                        let message =
                            "Download gagal.";

                        try {

                            const data =
                                await response.json();

                            if (data && data.error) {
                                message = data.error;
                            }

                        } catch (_) {}

                        throw new Error(message);
                    }

                    const blob =
                        await response.blob();

                    const blobUrl =
                        URL.createObjectURL(blob);

                    const temp =
                        document.createElement("a");

                    temp.href = blobUrl;
                      const safeProductName =
                          String(
                              transaction.productName ||
                              productName ||
                              "DIGITAL"
                          )
                          .trim()
                          .replace(/[<>:"/\\|?*]+/g, "")
                          .replace(/\s+/g, "-")
                          .toUpperCase();

                      const presetProductName =
                          safeProductName.endsWith("-PRESET")
                              ? safeProductName
                              : safeProductName + "-PRESET";

                      temp.download =
                          "BAYORA-" +
                          presetProductName +
                          ".zip";

                    document.body.appendChild(temp);
                    temp.click();
                    temp.remove();

                    URL.revokeObjectURL(blobUrl);

                } catch (error) {

                    console.error(
                        "[BAYORA PRESET DOWNLOAD]",
                        error
                    );

                    alert(
                        error.message ||
                        "Download gagal."
                    );

                } finally {

                    presetLink.innerHTML =
                        originalText;

                }

            }
        );

        preset.appendChild(
            presetLink
        );

        const guide =
            document.createElement("div");

        guide.className =
            "bayora-download-item";

        guide.innerHTML = `
            <div class="bayora-file-icon">
                PDF
            </div>

            <div class="bayora-file-info">
                <div class="bayora-file-title">
                    Download Panduan
                </div>

                <div class="bayora-file-meta">
                    Panduan penggunaan<br>
                    sesuai perangkat
                </div>
            </div>
        `;

        const guideLink =
            document.createElement("a");

        guideLink.className =
            "bayora-download-button";

        guideLink.href =
            `/api/digital-products/download-guide/${encodeURIComponent(
                transactionId
            )}`;

        guideLink.dataset.downloadUrl =
            guideLink.href;

        guideLink.removeAttribute("target");
        guideLink.removeAttribute("rel");

        guideLink.innerHTML =
            "↓&nbsp; Download";

        guideLink.addEventListener(
            "click",
            async event => {

                event.preventDefault();

                if (!downloadToken) {

                    alert(
                        "Token download tidak tersedia. Silakan muat ulang halaman."
                    );

                    return;
                }

                const originalText =
                    guideLink.innerHTML;

                guideLink.innerHTML =
                    "MENYIAPKAN DOWNLOAD...";

                try {

                    const response =
                        await fetch(
                            guideLink.dataset.downloadUrl,
                            {
                                method: "GET",
                                headers: {
                                    Authorization:
                                        "Bearer " +
                                        downloadToken
                                },
                                cache: "no-store"
                            }
                        );

                    if (!response.ok) {

                        let message =
                            "Download gagal.";

                        try {

                            const data =
                                await response.json();

                            if (data && data.error) {
                                message = data.error;
                            }

                        } catch (_) {}

                        throw new Error(message);
                    }

                    const blob =
                        await response.blob();

                    const blobUrl =
                        URL.createObjectURL(blob);

                    const temp =
                        document.createElement("a");

                    temp.href = blobUrl;
                      let deviceName =
                          String(
                              transaction.device ||
                              ""
                          )
                          .trim()
                          .toLowerCase();

                      if (deviceName === "ios") {
                          deviceName = "IOS";
                      } else if (
                          deviceName === "android"
                      ) {
                          deviceName = "ANDROID";
                      } else if (
                          deviceName === "macos" ||
                          deviceName === "mac"
                      ) {
                          deviceName = "MACOS";
                      } else if (
                          deviceName === "windows"
                      ) {
                          deviceName = "WINDOWS";
                      } else {
                          deviceName = "DEVICE";
                      }

                      temp.download =
                          "BAYORA-" +
                          deviceName +
                          "-PANDUAN.pdf";

                    document.body.appendChild(temp);
                    temp.click();
                    temp.remove();

                    URL.revokeObjectURL(blobUrl);

                } catch (error) {

                    console.error(
                        "[BAYORA GUIDE DOWNLOAD]",
                        error
                    );

                    alert(
                        error.message ||
                        "Download gagal."
                    );

                } finally {

                    guideLink.innerHTML =
                        originalText;

                }

            }
        );

        guide.appendChild(
            guideLink
        );

        downloads.appendChild(
            preset
        );

        downloads.appendChild(
            guide
        );

        filesSection.appendChild(
            downloads
        );

        /*
         * =================================================
         * EMAIL NOTICE
         * =================================================
         */

        const emailNotice =
            document.createElement("div");

        emailNotice.className =
            "bayora-email-notice";

        emailNotice.innerHTML =
            "File pesanan juga telah dikirim ke email " +
            "<strong>" +
            email +
            "</strong> sebagai cadangan.";

        /*
         * =================================================
         * HOME BUTTON
         * =================================================
         */

        const homeButton =
            document.createElement("button");

        homeButton.className =
            "bayora-home-button";

        homeButton.type =
            "button";

        homeButton.textContent =
            "⌂  Kembali ke Beranda";

        homeButton.onclick =
            () => showHome();

        /*
         * =================================================
         * MAIN CARD
         * =================================================
         */

        main.appendChild(icon);
        main.appendChild(demo);
        main.appendChild(title);
        main.appendChild(description);
        main.appendChild(divider);
        main.appendChild(summary);
        main.appendChild(filesSection);
        main.appendChild(emailNotice);
        main.appendChild(homeButton);

        /*
         * =================================================
         * SIDEBAR
         * =================================================
         */

        const sidebar =
            document.createElement("aside");

        sidebar.id =
            "bayoraDigitalSidebar";

        sidebar.innerHTML = `

            <div class="bayora-side-card">

                <h3 class="bayora-side-title">
                    BUTUH BANTUAN?
                </h3>

                <div class="bayora-side-icon">
                    ♧
                </div>

                <p class="bayora-side-text">
                    Jika mengalami kendala saat
                    download atau file tidak dapat
                    dibuka, silakan hubungi kami.
                </p>

                <a
                    class="bayora-contact"
                    href="https://wa.me/6285128045458"
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    💬 &nbsp; Hubungi Admin
                </a>

            </div>

            <div class="bayora-side-card">

                <h3 class="bayora-side-title">
                    KEAMANAN TRANSAKSI
                </h3>

                <div class="bayora-side-icon">
                    ♢
                </div>

                <ul class="bayora-security-list">
                    <li>
                        Transaksi aman & terenkripsi
                    </li>

                    <li>
                        Pembayaran diproses oleh
                        Xendit
                    </li>

                    <li>
                        Data Anda 100% aman
                    </li>

                    <li>
                        Akses produk setelah pembayaran berhasil
                    </li>
                </ul>

                <div class="bayora-side-brand">
                    BAYORA
                </div>

            </div>
        `;

        layout.appendChild(main);
        layout.appendChild(sidebar);

        /*
         * =================================================
         * REPLACE SUCCESS CONTENT
         * =================================================
         */

        successBox.innerHTML = "";

        successBox.style.cssText =
            "display:block;" +
            "width:100%;" +
            "max-width:none;" +
            "padding:0;" +
            "margin:0;" +
            "background:transparent;" +
            "border:0;" +
            "box-shadow:none;";

        successBox.appendChild(
            layout
        );

        successPage.classList.add(
            "bayora-digital-success"
        );

        console.log(
            "[BAYORA DIGITAL SUCCESS] " +
            "Layout disamakan dengan referensi email."
        );

    })
    .catch(error => {

        console.error(
            "[BAYORA DIGITAL SUCCESS]",
            error
        );

    });
}



/* =========================================================
   BAYORA — DIGITAL DOWNLOAD RESPONSIVE
========================================================= */

(function injectDigitalDownloadResponsiveCSS() {

    if (
        document.getElementById(
            "bayoraDigitalDownloadResponsive"
        )
    ) {
        return;
    }

    const style =
        document.createElement("style");

    style.id =
        "bayoraDigitalDownloadResponsive";

    style.textContent = `

        #successPage #orderSummary {
            width: 100% !important;
            max-width: 100% !important;
            min-width: 0 !important;
            display: block !important;
            box-sizing: border-box !important;
            grid-column: 1 / -1 !important;
            flex: 0 0 100% !important;
            margin: 0 !important;
            padding: 0 !important;
        }

        #successPage #digitalDownloadContainer {
            width: 100% !important;
            max-width: 100% !important;
            min-width: 0 !important;
            box-sizing: border-box !important;
        }

        @media screen and (max-width: 700px) {

            #successPage {
                width: 100% !important;
                max-width: 100% !important;
                box-sizing: border-box !important;
            }

            #successPage .success-box {
                width: 100% !important;
                max-width: 100% !important;
                box-sizing: border-box !important;
            }

            #successPage #orderSummary {
                width: 100% !important;
                max-width: 100% !important;
                min-width: 0 !important;
                grid-column: 1 / -1 !important;
            }

            #successPage #digitalDownloadContainer {
                width: 100% !important;
                max-width: 100% !important;
                margin-top: 22px !important;
                padding: 20px !important;
                border-radius: 18px !important;
            }

            #successPage #digitalDownloadContainer > div:first-child {
                margin: -20px -20px 20px !important;
                padding: 24px 20px 22px !important;
            }

            #successPage #digitalDownloadContainer a {
                width: 100% !important;
                max-width: 100% !important;
                min-width: 0 !important;
                box-sizing: border-box !important;
            }
        }

    `;

    document.head.appendChild(style);

})();




/* =====================================================
 * BAYORA — DIGITAL SUCCESS LAYOUT FIX
 * ===================================================== */

(function fixBayoraDigitalSuccessLayout() {

    function applyDigitalSuccessLayout() {

        const successPage =
            document.getElementById("successPage");

        const successBox =
            successPage
                ? successPage.querySelector(".success-box")
                : null;

        const orderSummary =
            document.getElementById("orderSummary");

        if (
            !successPage ||
            !successBox ||
            !orderSummary
        ) {
            return;
        }

        /*
         * =================================================
         * SUCCESS PAGE
         * =================================================
         *
         * Desktop:
         *   success card
         *       ↓
         *   download card
         *
         * Mobile:
         *   tetap satu kolom
         */

        successPage.style.display =
            "flex";

        successPage.style.flexDirection =
            "column";

        successPage.style.alignItems =
            "center";

        successPage.style.justifyContent =
            "flex-start";

        successPage.style.width =
            "100%";

        successPage.style.boxSizing =
            "border-box";

        /*
         * SUCCESS CARD
         */

        successBox.style.width =
            "100%";

        successBox.style.maxWidth =
            "560px";

        successBox.style.boxSizing =
            "border-box";

        /*
         * ORDER SUMMARY
         */

        orderSummary.style.display =
            "block";

        orderSummary.style.width =
            "100%";

        orderSummary.style.maxWidth =
            "560px";

        orderSummary.style.minWidth =
            "0";

        orderSummary.style.boxSizing =
            "border-box";

        orderSummary.style.flex =
            "0 1 auto";

        orderSummary.style.margin =
            "24px 0 0";

        /*
         * Pastikan tidak diperlakukan
         * sebagai grid/flex column terpisah.
         */

        orderSummary.style.gridColumn =
            "auto";

        orderSummary.style.gridRow =
            "auto";

        /*
         * DOWNLOAD CONTAINER
         */

        const download =
            document.getElementById(
                "digitalDownloadContainer"
            );

        if (download) {

            download.style.width =
                "100%";

            download.style.maxWidth =
                "100%";

            download.style.minWidth =
                "0";

            download.style.boxSizing =
                "border-box";

            download.style.margin =
                "0";

        }

        /*
         * RESPONSIVE
         */

        if (
            window.matchMedia(
                "(max-width: 700px)"
            ).matches
        ) {

            successPage.style.padding =
                "40px 16px";

            successBox.style.width =
                "100%";

            successBox.style.maxWidth =
                "560px";

            orderSummary.style.width =
                "100%";

            orderSummary.style.maxWidth =
                "560px";

        }

    }


    /*
     * Jalankan sekarang
     */

    applyDigitalSuccessLayout();


    /*
     * Jalankan lagi setelah DOM berubah.
     * Flow pembayaran memang membuat
     * orderSummary secara dinamis.
     */

    const observer =
        new MutationObserver(() => {

            if (
                document.getElementById(
                    "digitalDownloadContainer"
                )
            ) {
                applyDigitalSuccessLayout();
            }

        });

    observer.observe(
        document.body,
        {
            childList: true,
            subtree: true
        }
    );


    /*
     * Responsive saat ukuran layar berubah.
     */

    window.addEventListener(
        "resize",
        applyDigitalSuccessLayout
    );

})();


async function checkTransactionStatus(transactionId) {

    try {

        /*
         * =================================================
         * BAYORA — XENDIT DIGITAL AUTO SYNC
         * =================================================
         *
         * Khusus transaksi DIGITAL-* dengan pembayaran
         * Xendit. Server akan mengecek Payment Session
         * langsung ke Xendit sebelum membaca status lokal.
         *
         * Tidak menyentuh transaksi PPOB.
         */

        if (
            String(transactionId || "")
                .startsWith("DIGITAL-")
        ) {

            try {

                const syncResponse =
                    await fetch(
                        `/api/transactions/${encodeURIComponent(transactionId)}/sync-xendit`,
                        {
                            method: "POST",
                            headers: {
                                "Content-Type":
                                    "application/json"
                            }
                        }
                    );

                const syncData =
                    await syncResponse.json();

                if (syncData?.downloadToken) {

                    window.BAYORA_DIGITAL_DOWNLOAD_TOKEN =
                        syncData.downloadToken;

                }

            } catch (syncError) {

                console.warn(
                    "[XENDIT DIGITAL SYNC]",
                    syncError
                );

            }

        }

        const response = await fetch(
            `/api/transactions/${encodeURIComponent(transactionId)}`
        );

        const data = await response.json();

        if (!data.success || !data.transaction) {
            return;
        }

        const transaction =
            data.transaction;

        const statusElement =
            document.getElementById("transactionStatus");

        if (!statusElement) {
            return;
        }

        const isDigital =
            transaction.productType === "digital";

        const paymentStatus =
            transaction.paymentStatus;

        const status =
            transaction.status;

        /*
         * PRODUK DIGITAL
         *
         * Produk digital tidak dikirim ke Digiflazz.
         * Jadi status transaksi boleh tetap PENDING,
         * tetapi akses diberikan setelah payment_status
         * benar-benar PAID.
         */
        if (isDigital) {

            if (paymentStatus === "PAID") {

                statusElement.textContent =
                    "PEMBAYARAN BERHASIL";

                showDigitalDownloadButton(
                    transactionId,
                    transaction.productName,
                    window.BAYORA_DIGITAL_DOWNLOAD_TOKEN || null
                );

                return;

            }

            if (paymentStatus === "EXPIRED") {

                statusElement.textContent =
                    "PEMBAYARAN KEDALUWARSA";

                return;

            }

            statusElement.textContent =
                "MENUNGGU PEMBAYARAN";

            setTimeout(
                () => checkTransactionStatus(transactionId),
                3000
            );

            return;
        }

        /*
         * PRODUK PPOB
         *
         * Pertahankan alur status Digiflazz
         * seperti sebelumnya.
         */
        if (status === "SUCCESS") {

            statusElement.textContent =
                "TRANSAKSI BERHASIL";

        } else if (status === "FAILED") {

            statusElement.textContent =
                "TRANSAKSI GAGAL";

        } else {

            statusElement.textContent =
                "MENUNGGU PEMBAYARAN";

        }

        if (status === "PENDING") {

            setTimeout(
                () => checkTransactionStatus(transactionId),
                3000
            );

        }

    } catch (error) {

        console.error(
            "Status check error:",
            error
        );

    }

}


/* =========================================================
   HANDLE XENDIT RETURN
========================================================= */

async function handleXenditReturn() {

    const params =
        new URLSearchParams(
            window.location.search
        );

    const payment =
        params.get("payment");

    const transactionId =
        params.get("transactionId");

    if (
        !transactionId ||
        (
            payment !== "success" &&
            payment !== "cancel"
        )
    ) {
        return;
    }

    const homePage =
        document.getElementById("homePage");

    const servicePage =
        document.getElementById("servicePage");

    const checkoutPage =
        document.getElementById("checkoutPage");

    const successPage =
        document.getElementById("successPage");

    if (homePage) {
        homePage.classList.add("page-hidden");
    }

    if (servicePage) {
        servicePage.classList.add("page-hidden");
    }

    if (checkoutPage) {
        checkoutPage.classList.add("page-hidden");
    }

    if (!successPage) {
        return;
    }

    successPage.classList.remove("page-hidden");

    /*
     * =====================================================
     * BAYORA — XENDIT RETURN DIGITAL
     * =====================================================
     *
     * Setelah kembali dari Xendit, halaman success harus
     * langsung memeriksa transaksi berdasarkan transactionId.
     *
     * Khusus produk digital guest:
     * - tidak membutuhkan login
     * - transaction tetap dapat dibaca lewat endpoint publik
     * - status pembayaran diverifikasi server
     * - download hanya muncul setelah paymentStatus = PAID
     */

    if (payment === "success") {

        try {

            const response =
                await fetch(
                    "/api/transactions/" +
                    encodeURIComponent(transactionId)
                );

            const data =
                await response.json();

            if (
                data.success &&
                data.transaction
            ) {

                const transaction =
                    data.transaction;

                const isDigital =
                    transaction.productType === "digital";

                if (isDigital) {

                    const successBox =
                        successPage.querySelector(
                            ".success-box"
                        );

                    if (successBox) {

                        /*
                         * Buat area status jika belum ada.
                         */
                        let statusElement =
                            document.getElementById(
                                "transactionStatus"
                            );

                        if (!statusElement) {

                            statusElement =
                                document.createElement(
                                    "div"
                                );

                            statusElement.id =
                                "transactionStatus";

                            statusElement.style.marginTop =
                                "14px";

                            statusElement.style.fontWeight =
                                "700";

                            statusElement.style.color =
                                "#1769ff";

                            successBox.appendChild(
                                statusElement
                            );
                        }

                        statusElement.textContent =
                            "MEMERIKSA PEMBAYARAN";

                        /*
                         * Buat orderSummary agar
                         * showDigitalDownloadButton()
                         * mempunyai tempat untuk menampilkan
                         * file digital.
                         */
                        let orderSummary =
                            document.getElementById(
                                "orderSummary"
                            );

                        if (!orderSummary) {

                            orderSummary =
                                document.createElement(
                                    "div"
                                );

                            orderSummary.id =
                                "orderSummary";

                            orderSummary.className =
                                "order-summary";

                            successBox.appendChild(
                                orderSummary
                            );
                        }

                        /*
                         * Mulai verifikasi transaksi.
                         *
                         * Fungsi ini akan:
                         * PENDING → polling
                         * PAID    → tampilkan download
                         * EXPIRED → tampilkan kedaluwarsa
                         */
                        checkTransactionStatus(
                            transactionId
                        );

                    }

                    return;
                }

            }

        } catch (error) {

            console.error(
                "[XENDIT RETURN DIGITAL]",
                error
            );

        }

    }

    if (payment === "cancel") {

        successPage.innerHTML = `
            <div style="
                padding:40px 24px;
                text-align:center;
            ">
                <h2>Pembayaran Dibatalkan</h2>

                <p style="
                    margin-top:10px;
                    color:#64748b;
                ">
                    Pembayaran transaksi
                    ${transactionId}
                    dibatalkan.
                </p>
            </div>
        `;

        return;
    }

    try {

        const response =
            await fetch(
                `/api/transactions/${encodeURIComponent(transactionId)}`
            );

        const data =
            await response.json();

        if (
            !response.ok ||
            !data.success ||
            !data.transaction
        ) {
            throw new Error(
                data.error ||
                "Transaksi tidak ditemukan."
            );
        }

        const transaction =
            data.transaction;

        if (
            transaction.productType === "digital"
        ) {

            if (
                transaction.paymentStatus === "PAID"
            ) {

                showDigitalDownloadButton(
                    transaction.transactionId,
                    transaction.productName,
                    window.BAYORA_DIGITAL_DOWNLOAD_TOKEN || null
                );

                return;
            }

            setTimeout(
                () => handleXenditReturn(),
                3000
            );

            return;
        }

        checkTransactionStatus(
            transaction.transactionId
        );

    } catch (error) {

        console.error(
            "Xendit return error:",
            error
        );

        successPage.innerHTML = `
            <div style="
                padding:40px 24px;
                text-align:center;
            ">
                <h2>Memeriksa Pembayaran</h2>

                <p style="
                    margin-top:10px;
                    color:#64748b;
                ">
                    Pembayaran sedang diverifikasi.
                    Silakan tunggu beberapa saat.
                </p>
            </div>
        `;

    }

}


function getPaymentName(payment) {

    if (payment === "qris") {
        return "QRIS";
    }

    if (payment === "ewallet") {
        return "E-Wallet";
    }

    if (payment === "bank") {
        return "Virtual Account";
    }

    return payment;

}


/* =========================================================
   INITIALIZE DIGITAL PRODUCT FLOW
========================================================= */

setupDigitalProductFlow();

handleXenditReturn();
