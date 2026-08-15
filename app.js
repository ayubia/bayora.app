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
                placeholder: service.placeholder
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
                operator: product.operator || ""
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

    if (!entries.length) {

        grid.innerHTML = `
            <div
                style="
                    grid-column:1/-1;
                    text-align:center;
                    padding:30px 10px;
                    color:#888;
                "
            >
                Belum ada layanan tersedia.
            </div>
        `;

        return;
    }

    grid.innerHTML =
        entries.map(([id, service]) => {

            const safeId =
                String(id)
                    .replace(/\\/g, "\\\\")
                    .replace(/'/g, "\\'");

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

    document
        .getElementById("operator")
        .value = "";

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


function renderProducts() {

    const grid =
        document.getElementById("productGrid");

    const count =
        document.getElementById("productCount");

    grid.innerHTML = "";

    const list =
        products[currentService] || [];

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


async function processPayment() {

    // Pembayaran menggunakan Xendit secara otomatis.
    const payment = "xendit";


    const service =
        services[currentService];


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


async function checkTransactionStatus(transactionId) {

    try {

        const response = await fetch(
            `/api/transactions/${transactionId}`
        );

        const data = await response.json();

        if (!data.success || !data.transaction) {
            return;
        }

        const statusElement =
            document.getElementById("transactionStatus");

        if (!statusElement) {
            return;
        }

        const status =
            data.transaction.status;

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