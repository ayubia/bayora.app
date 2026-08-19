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


let currentService = null;
let currentProduct = null;

window.showAllDigitalProducts = false;

let selectedDigitalProducts = [];

let digitalCustomerEmail = "";
let digitalCustomerWhatsapp = "";
let selectedDigitalDevice = "";


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

        renderCustomerServices();

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
                service.icon || "📦";

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
                    🧾
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
                    ✨
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


function openService(serviceId) {

    const service = services[serviceId];

    if (!service) {
        return;
    }

    currentService = serviceId;
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
                "#servicePage .form-header"
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

        if (typeof updateDigitalSelection === "function") {
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
            "#servicePage .form-header"
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


    document
        .getElementById("formIcon")
        .textContent = service.icon;

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

let digitalProductFilter = "all";


function setDigitalProductFilter(filter) {

    digitalProductFilter =
        filter === "lightroom"
            ? "lightroom"
            : "all";

    document
        .querySelectorAll(".digital-product-filter")
        .forEach(button => {

            button.classList.toggle(
                "active",
                button.dataset.filter === digitalProductFilter
            );

        });

    renderDigitalProducts();

}


function getDigitalProducts() {

    const list =
        (products[currentService] || [])
            .filter(product =>
                product.productType === "digital"
            );

    if (digitalProductFilter === "lightroom") {

        return list.filter(product =>
            product.digitalCategory === "lightroom" ||
            product.digitalCategory === "preset" ||
            !product.digitalCategory
        );

    }

    return list;

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


    const showAll =
        Boolean(window.showAllDigitalProducts);

    const list =
        showAll
            ? allDigitalProducts
            : allDigitalProducts.slice(0, 4);

    const catalogButton =
        document.getElementById(
            "selectAllDigitalProducts"
        );

    if (catalogButton) {

        if (allDigitalProducts.length > 4) {

            catalogButton.style.display = "";

            catalogButton.textContent =
                showAll
                    ? "Tampilkan 4 Produk"
                    : "Semua Produk";

        } else {

            catalogButton.style.display = "none";

        }

    }

    list.forEach(product => {

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
         * KATALOG DIGITAL
         *
         * Before + After ditampilkan sebagai slider 1:1.
         * Gallery detail tidak digunakan di sini.
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
                        data-before="${beforeImage}"
                        data-after="${afterImage}"
                    >

                        <div
                            class="digital-before-after-track"
                        >

                            <img
                                class="digital-before-after-image digital-before-image"
                                src="${beforeImage}"
                                alt="${product.name} Before"
                                loading="lazy"
                            >

                            <img
                                class="digital-before-after-image digital-after-image"
                                src="${afterImage}"
                                alt="${product.name} After"
                                loading="lazy"
                            >

                        </div>

                        <div
                            class="digital-before-after-divider"
                        ></div>

                        <span
                            class="digital-before-after-label digital-before-label"
                        >
                            BEFORE
                        </span>

                        <span
                            class="digital-before-after-label digital-after-label"
                        >
                            AFTER
                        </span>

                        <input
                            class="digital-before-after-range"
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
                        <div class="digital-product-image digital-product-image-empty">
                            <span>PRESET</span>
                        </div>
                    `;


        card.innerHTML = `

            ${image}

            <div class="digital-product-card-body">

                <div class="digital-product-card-top">

                    <div>

                        <p class="eyebrow">
                            LIGHTROOM PRESET
                        </p>

                        <h4>
                            ${product.name}
                        </h4>

                    </div>

                    <strong>
                        ${formatDigitalProductPrice(product.price)}
                    </strong>

                </div>


                <p class="digital-product-info">
                    ${product.info || "Preset Lightroom untuk mempercantik foto kamu."}
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


        const detailButton =
            card.querySelector(
                ".digital-detail-button"
            );

        const pickButton =
            card.querySelector(
                ".digital-pick-button"
            );


        detailButton.onclick = () => {

            openDigitalProductDetail(
                product
            );

        };


        pickButton.onclick = () => {

            toggleDigitalProduct(
                product
            );

        };


        grid.appendChild(card);

    });

    setupDigitalBeforeAfterSliders();

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

        if (
            !range ||
            !afterImage ||
            !divider
        ) {
            return;
        }

        const update = () => {

            const value =
                Number(range.value);

            afterImage.style.clipPath =
                `inset(0 ${100 - value}% 0 0)`;

            divider.style.left =
                `${value}%`;

        };

        range.addEventListener(
            "input",
            update
        );

        update();

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


let digitalGalleryImages = [];
let digitalGalleryIndex = 0;


function renderDigitalGallery() {

    const gallery =
        document.getElementById(
            "digitalDetailGallery"
        );


    if (!gallery) {
        return;
    }


    gallery.innerHTML = "";


    if (!digitalGalleryImages.length) {

        gallery.innerHTML = `
            <div class="digital-detail-gallery-empty">
                Preview belum tersedia.
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
        window.currentDigitalDetailProduct?.name ||
        "Preview preset";

    image.loading = "eager";


    gallery.appendChild(image);


    /*
     * Tombol navigasi hanya ditampilkan
     * jika ada lebih dari satu gambar.
     */

    if (
        digitalGalleryImages.length > 1
    ) {

        const previous =
            document.createElement("button");

        previous.type = "button";
        previous.className =
            "digital-gallery-nav digital-gallery-prev";

        previous.innerHTML = "‹";

        previous.onclick = () => {

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
            document.createElement("button");

        next.type = "button";
        next.className =
            "digital-gallery-nav digital-gallery-next";

        next.innerHTML = "›";

        next.onclick = () => {

            digitalGalleryIndex =
                (
                    digitalGalleryIndex +
                    1
                ) %
                digitalGalleryImages.length;

            renderDigitalGallery();

        };


        gallery.appendChild(previous);
        gallery.appendChild(next);


        const indicator =
            document.createElement("div");

        indicator.className =
            "digital-gallery-indicator";

        indicator.textContent =
            `${digitalGalleryIndex + 1} / ${digitalGalleryImages.length}`;

        gallery.appendChild(indicator);

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


    document.body.style.overflow =
        "hidden";

}


function closeDigitalProductDetail() {

    const modal =
        document.getElementById(
            "digitalProductDetailModal"
        );

    if (modal) {

        modal.classList.add(
            "page-hidden"
        );

    }


    document.body.style.overflow =
        "";

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


setupDigitalProductFlow();



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


function renderDigitalCheckout() {

    const service =
        services[currentService];


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
                        ${formatDigitalProductPrice(product.price)}
                    </strong>

                </div>

            `)
            .join("");


    document
        .getElementById(
            "checkoutSummary"
        )
        .innerHTML = `

            <div class="checkout-row">

                <span>
                    Layanan
                </span>

                <strong>
                    ${service.icon || "✨"}
                    ${service.title}
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


            <div class="checkout-row">

                <span>
                    Perangkat
                </span>

                <strong>
                    ${selectedDigitalDevice}
                </strong>

            </div>


            <div
                class="digital-checkout-products"
            >

                <div
                    class="checkout-row"
                >

                    <span>
                        Produk
                    </span>

                    <strong>
                        ${selectedDigitalProducts.length}
                        preset
                    </strong>

                </div>

                ${productRows}

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


function backToDigitalProducts() {

    document
        .getElementById("checkoutPage")
        .classList.add(
            "page-hidden"
        );

    document
        .getElementById("servicePage")
        .classList.remove(
            "page-hidden"
        );


    window.scrollTo({
        top: 0,
        behavior: "smooth"
    });

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
    productName
) {

    const successPage =
        document.getElementById("successPage");

    if (!successPage) {
        return;
    }

    const existing =
        document.getElementById(
            "digitalDownloadContainer"
        );

    if (existing) {
        return;
    }

    const container =
        document.createElement("div");

    container.id =
        "digitalDownloadContainer";

    container.style.marginTop =
        "20px";

    container.style.textAlign =
        "center";

    const title =
        document.createElement("p");

    title.textContent =
        productName
            ? `Produk ${productName} siap didownload.`
            : "Produk digital kamu siap didownload.";

    title.style.marginBottom =
        "12px";

    const button =
        document.createElement("a");

    button.href =
        `/api/digital-products/download/${encodeURIComponent(transactionId)}`;

    button.textContent =
        "Download Produk";

    button.setAttribute(
        "download",
        ""
    );

    button.style.display =
        "inline-block";

    button.style.textDecoration =
        "none";

    button.style.cursor =
        "pointer";

    container.appendChild(title);

    container.appendChild(button);

    successPage.appendChild(container);

}


async function checkTransactionStatus(transactionId) {

    try {

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
                    transaction.productName
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