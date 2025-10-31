// FAQ toggle function
function toggleFaq(button) {
    const faqItem = button.parentElement;
    const isActive = faqItem.classList.contains('active');
    // Close all FAQ items
    document.querySelectorAll('.faq-item').forEach(item => {
        item.classList.remove('active');
    });
    // If this item wasn't active, open it
    if (!isActive) {
        faqItem.classList.add('active');
    }
}

// MOVED from HTML: FAQ Sub-Accordion toggle function
function toggleSubFaq(button) {
    const subItem = button.parentElement;
    if (subItem) {
        subItem.classList.toggle('active');
    }
}

// Case Study Accordion toggle function
function toggleCaseStudyAccordion(button) {
    const caseStudyItem = button.parentElement;
    const isActive = caseStudyItem.classList.contains('active');
    // Close all other case study items
    document.querySelectorAll('.case-studies-accordion .case-study-item').forEach(item => {
        if (item !== caseStudyItem) {
            item.classList.remove('active');
        }
    });
    // Toggle the clicked item
    caseStudyItem.classList.toggle('active');
}

// Case Study Sub-Accordion toggle function
function toggleCaseStudySubAccordion(button) {
    const subItem = button.parentElement;
    const isActive = subItem.classList.contains('active');
    // Close all sibling sub-items
    const parentContainer = subItem.parentElement;
    parentContainer.querySelectorAll('.case-study-sub-item').forEach(item => {
        if (item !== subItem) {
            item.classList.remove('active');
        }
    });
    // Toggle the clicked sub-item
    subItem.classList.toggle('active');
}

// Animation on scroll
document.addEventListener('DOMContentLoaded', function() {
    const testimonialCards = document.querySelectorAll('.testimonial-card, .testimonial-card-1, .testimonial-card-2, .testimonial-card-3');
    const serviceCards = document.querySelectorAll('[class^="service-card-"]');
    const caseStudyCards = document.querySelectorAll('.case-study-card-1, .case-study-card-2, .case-study-card-3');
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                // Animate testimonials
                if (entry.target.classList.contains('testimonials-section')) {
                    const cards = entry.target.querySelectorAll('.testimonial-card-1, .testimonial-card-2, .testimonial-card-3');
                    cards.forEach((card, index) => {
                        setTimeout(() => {
                            card.classList.add('animate');
                        }, index * 200);
                    });
                }
                // Animate services
                else if (entry.target.classList.contains('services-section')) {
                    const cards = entry.target.querySelectorAll('[class^="service-card-"]');
                    cards.forEach((card) => {
                        card.classList.add('animate');
                    });
                }
                // Animate case studies
                else if (entry.target.classList.contains('case-studies-section')) {
                    const cards = entry.target.querySelectorAll('.case-study-card-1, .case-study-card-2, .case-study-card-3');
                    cards.forEach((card, index) => {
                        setTimeout(() => {
                            card.classList.add('animate');
                        }, index * 200);
                    });
                }
                observer.unobserve(entry.target);
            }
        });
    }, { threshold: 0.1 });
    
    const testimonialsSection = document.querySelector('.testimonials-section');
    const servicesSection = document.querySelector('.services-section');
    const caseStudiesSection = document.querySelector('.case-studies-section');
    
    if (testimonialsSection) {
        observer.observe(testimonialsSection);
    }
    if (servicesSection) {
        observer.observe(servicesSection);
    }
    if (caseStudiesSection) {
        observer.observe(caseStudiesSection);
    }
    
    // Burger Menu functionality
    const burgerIcon = document.getElementById('burgerIcon');
    const mobileMenuItems = document.getElementById('mobileMenuItems');
    
    if (burgerIcon && mobileMenuItems) {
        burgerIcon.addEventListener('click', (event) => {
            event.stopPropagation(); 
            mobileMenuItems.classList.toggle('active');
        });
        
        mobileMenuItems.querySelectorAll('.menu-item').forEach(item => {
            item.addEventListener('click', () => {
                mobileMenuItems.classList.remove('active');
            });
        });
        
        document.body.addEventListener('click', (event) => {
            if (mobileMenuItems.classList.contains('active') && 
                !mobileMenuItems.contains(event.target) && 
                !burgerIcon.contains(event.target)) {
                mobileMenuItems.classList.remove('active');
            }
        });
    }

    // Custom Slow Scroll
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const targetId = this.getAttribute('href');
            const targetElement = document.querySelector(targetId);

            if (targetElement) {
                const menuHeight = document.querySelector('.main-menu').offsetHeight;
                const targetPosition = targetElement.getBoundingClientRect().top + window.pageYOffset - menuHeight;
                const startPosition = window.pageYOffset;
                const distance = targetPosition - startPosition;
                let startTime = null;
                const duration = 1000;

                function animation(currentTime) {
                    if (startTime === null) startTime = currentTime;
                    const timeElapsed = currentTime - startTime;
                    const run = ease(timeElapsed, startPosition, distance, duration);
                    window.scrollTo(0, run);
                    if (timeElapsed < duration) requestAnimationFrame(animation);
                }

                function ease(t, b, c, d) {
                    t /= d / 2;
                    if (t < 1) return c / 2 * t * t + b;
                    t--;
                    return -c / 2 * (t * (t - 2) - 1) + b;
                }

                requestAnimationFrame(animation);
            }
        });
    });

    // --- FORM VALIDATION ---
    const contactForm = document.getElementById('contactForm');
    if (contactForm) {
        contactForm.addEventListener('submit', function(e) {
            let isValid = true;

            const nameInput = document.getElementById('name');
            const emailInput = document.getElementById('email');
            const messageInput = document.getElementById('message');
            const nameError = document.getElementById('name-error');
            const emailError = document.getElementById('email-error');
            const messageError = document.getElementById('message-error');
            
            // Reset previous errors
            [nameInput, emailInput, messageInput].forEach(input => input.classList.remove('error'));
            [nameError, emailError, messageError].forEach(error => error.style.display = 'none');

            // Name Validation: Check for empty value and numbers
            if (nameInput.value.trim() === '') {
                nameError.textContent = 'Name is required.';
                nameError.style.display = 'block';
                nameInput.classList.add('error');
                isValid = false;
            } else if (/\d/.test(nameInput.value)) {
                nameError.textContent = 'Name cannot contain numbers.';
                nameError.style.display = 'block';
                nameInput.classList.add('error');
                isValid = false;
            }

            // Email Validation: Check for empty value
            if (emailInput.value.trim() === '') {
                emailError.textContent = 'Please enter a valid email.';
                emailError.style.display = 'block';
                emailInput.classList.add('error');
                isValid = false;
            }

            // Message Validation: Check for empty value
            if (messageInput.value.trim() === '') {
                messageError.textContent = 'Please let me know how I can help.';
                messageError.style.display = 'block';
                messageInput.classList.add('error');
                isValid = false;
            }

            if (!isValid) {
                e.preventDefault(); // Prevent form submission if validation fails
            }
        });
    }

    // --- MOVED FROM HTML: PRICING CALCULATOR SCRIPT ---
    const pricingTable = document.getElementById('pricingTable');
    const slider = document.getElementById('spend-slider');
    const spendValue = document.getElementById('spend-value');
    const managementFee = document.getElementById('management-fee');
    const setupFeeRow = document.getElementById('setup-fee-row'); // Get the row
    const setupFee = document.getElementById('setup-fee');       // Get the cell
    const accountRadios = document.querySelectorAll('input[name="account"]');
    const googleCreditMessage = document.getElementById('googleCreditMessage'); // Get the credit message div

    // Check if all elements exist before adding listeners
    if (pricingTable && slider && spendValue && managementFee && setupFeeRow && setupFee && accountRadios.length > 0 && googleCreditMessage) {
        
        // State tracking for blur
        let radioAnswered = false;
        let sliderAnswered = false; // Slider is not considered "answered" on load, even at 0

        function checkAndUnblur() {
            // This function checks if both conditions are met
            if (radioAnswered && sliderAnswered) {
                pricingTable.classList.remove('blurred');
            }
        }

        // --- Event Listener for Radios ---
        accountRadios.forEach(radio => {
            radio.addEventListener('change', () => {
                radioAnswered = true; // Mark radio as answered
                checkAndUnblur();     // Check if we can unblur
                calculateFees();      // Recalculate fees (this will hide/show the row)
            });
        });

        // --- Event Listener for Slider ---
        slider.addEventListener('input', (e) => {
            const value = parseInt(e.target.value); // Get the value

            if (value > 0) {
                // If slider is moved to any value above 0
                if (!sliderAnswered) {
                    sliderAnswered = true; // Mark as answered
                }
                checkAndUnblur(); // Check if we can unblur
            } else {
                // If slider is moved back to 0
                sliderAnswered = false; // Mark as "unanswered" again
                pricingTable.classList.add('blurred'); // Re-apply the blur
            }

            // This part runs every time the slider moves
            spendValue.textContent = formatCurrency(value) + 'pm';
            calculateFees();
        });

        function formatCurrency(amount) {
            return '£' + amount.toLocaleString('en-GB');
        }

    function calculateFees() {
        const spend = parseInt(slider.value);
        
        // Check which radio is selected.
        const checkedRadio = document.querySelector('input[name="account"]:checked');
        const hasAccount = checkedRadio ? checkedRadio.value === 'yes' : false;
        const isNo = checkedRadio ? checkedRadio.value === 'no' : false; // ADDED
        const isOver4k = spend >= 4000; // ADDED

        // Calculate management fee
        let fee = 399;
        if (spend > 4000) {
            const increments = Math.floor((spend - 4000) / 500);
            fee = 399 + (increments * 50);
        }

        // --- NEW: Cap the fee at 3500 ---
        if (fee > 3500) {
            fee = 3500;
        }
        
        // UPDATED: Added 'pm' to the management fee
        managementFee.textContent = formatCurrency(fee) + 'pm';
        
        // --- REPLACED Logic for setup fee row AND Google Credit Message ---
        if (hasAccount) {
            // 'Yes' is selected
            setupFeeRow.style.display = 'none'; // Hide setup fee row
            googleCreditMessage.style.display = 'none'; // Hide credit message
        } else if (isNo) {
            // 'No' is selected
            googleCreditMessage.style.display = 'flex'; // Show credit message
            
            if (isOver4k) {
                // 'No' AND '>= £4k'
                setupFeeRow.style.display = 'none'; // Hide setup row
            } else {
                // 'No' AND '< £4k'
                setupFeeRow.style.display = ''; // Show setup fee row
                setupFee.textContent = '£99';
            }
        } else { 
            // No radio selected yet
            setupFeeRow.style.display = ''; // Show setup fee row
            setupFee.textContent = '£99';   // Set default text
            googleCreditMessage.style.display = 'none'; // Hide credit message
        }
    }

        // Initial call to set fees based on default (slider=0, radio=unchecked)
        // This will correctly show the £99 setup fee by default, but the table remains blurred
        calculateFees(); 
        
        // --- ADDED: Set initial slider text to include 'pm' ---
        spendValue.textContent = formatCurrency(parseInt(slider.value)) + 'pm';
    }
    // --- END: PRICING CALCULATOR SCRIPT ---

});

// Modal functions
function openModal(modalId) {
    document.getElementById(modalId).style.display = 'block'; 
    document.body.style.overflow = 'hidden';
}

function closeModal(modalId) {
    document.getElementById(modalId).style.display = 'none';
    document.body.style.overflow = 'auto';
}

window.onclick = function(event) {
    if (event.target.classList.contains('modal')) {
        event.target.style.display = 'none';
        document.body.style.overflow = 'auto';
    }
}
