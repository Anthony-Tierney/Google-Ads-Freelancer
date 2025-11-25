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

// FAQ Sub-Accordion toggle function
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

// Animation on scroll and DOM Ready Logic
document.addEventListener('DOMContentLoaded', function() {
    
    // --- 6) Desktop Navigation Highlighting Logic (Intersection Observer) ---
    const sections = document.querySelectorAll(
        '#home, #pricing, #testimonials, #services, #case-studies, #faq, #contact'
    );
    const navLinks = document.querySelectorAll('.main-menu .menu-item');
    const menuContainer = document.querySelector('.main-menu');
    
    // Function to add the active class to the corresponding menu link
    function activateLink(id) {
        navLinks.forEach(link => {
            link.classList.remove('active-link');
            if (link.getAttribute('href') === `#${id}`) {
                link.classList.add('active-link');
            }
        });
    }
    
    // Intersection Observer Callback for section visibility
    const navObserver = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                // Determine which section is most in view (or the first one visible)
                const visibleSections = Array.from(sections)
                    .filter(sec => {
                        const rect = sec.getBoundingClientRect();
                        // Check if at least 10% of the section is visible
                        return rect.top < (window.innerHeight * 0.9) && rect.bottom > (window.innerHeight * 0.1);
                    })
                    .sort((a, b) => {
                        // Sort by distance from top (closer to top is higher priority)
                        return a.getBoundingClientRect().top - b.getBoundingClientRect().top;
                    });

                if (visibleSections.length > 0) {
                    activateLink(visibleSections[0].id);
                } else if (window.scrollY === 0) {
                    // Special case for top of page
                    activateLink('home');
                }
            }
        });
    }, {
        root: null,
        rootMargin: '-50% 0px -49% 0px', // When the section center passes the viewport center
        threshold: 0 // We use rootMargin to handle the actual centering logic
    });
    
    // Observe all main sections
    sections.forEach(section => {
        navObserver.observe(section);
    });

    // --- End Desktop Navigation Highlighting Logic ---

    const testimonialCards = document.querySelectorAll('.testimonial-card, .testimonial-card-1, .testimonial-card-2, .testimonial-card-3');
    const serviceCards = document.querySelectorAll('[class^="service-card-"]');
    const caseStudyCards = document.querySelectorAll('.case-study-card-1, .case-study-card-2, .case-study-card-3');
    
    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                // Animate testimonials
                if (entry.target.classList.contains('testimonials-section')) {
                    const cards = entry.target.querySelectorAll('.testimonial-card-1, .testimonial-card-2, .testimonial-card-3');
                    // Removed the check for screen size since CSS controls mobile transition
                    cards.forEach((card, index) => {
                        setTimeout(() => {
                            card.classList.add('animate');
                        }, index * 200);
                    });
                }
                // Animate services
                else if (entry.target.classList.contains('services-section')) {
                    // Removed the check for screen size since CSS controls mobile transition
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
                // Only unobserve sections, individual cards are managed by the mobile observer
                if (entry.target.classList.contains('testimonials-section') || entry.target.classList.contains('services-section') || entry.target.classList.contains('case-studies-section')) {
                    observer.unobserve(entry.target);
                }
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

// Desktop Service Cards Carousel - Add to script.js inside DOMContentLoaded


    
// Service Cards Carousel (Desktop Only)
    if (window.innerWidth > 768) {
        const servicesSection = document.querySelector('.services-section');
        const servicesGrid = document.querySelector('.services-grid');
        const serviceCards = document.querySelectorAll('.services-grid > [class^="service-card-"]');
        
        if (servicesSection && servicesGrid && serviceCards.length > 0) {
            
            // 1. Create the NEW main carousel container
            const carouselContainer = document.createElement('div');
            carouselContainer.className = 'carousel-container-wrapper'; // This is our new relative parent

            // --- START: ADDED CODE ---
            // Create and add the counter element
            const counterElement = document.createElement('div');
            counterElement.className = 'service-card-counter';
            carouselContainer.appendChild(counterElement);
            // --- END: ADDED CODE ---

            // 2. Wrap the services grid in its existing wrapper
            const wrapper = document.createElement('div');
            wrapper.className = 'services-grid-wrapper';
            
            // 3. Put the grid wrapper inside the new main container
            carouselContainer.appendChild(wrapper);

            // 4. Put the grid inside its wrapper
            // We MUST insert the new container into the DOM *before* appending the grid
            servicesGrid.parentNode.insertBefore(carouselContainer, servicesGrid);
            wrapper.appendChild(servicesGrid); // Now we move the grid
            
            let currentIndex = 1;
            const cardsPerView = 1;
            const totalSlides = serviceCards.length;
            
            // Create navigation controls
            const navContainer = document.createElement('div');
            navContainer.className = 'carousel-nav';
            
            const prevBtn = document.createElement('button');
            prevBtn.className = 'carousel-btn carousel-prev';
            prevBtn.innerHTML = '<i class="fas fa-chevron-left"></i>';
            prevBtn.setAttribute('aria-label', 'Previous services');
            
            const nextBtn = document.createElement('button');
            nextBtn.className = 'carousel-btn carousel-next';
            nextBtn.innerHTML = '<i class="fas fa-chevron-right"></i>';
            nextBtn.setAttribute('aria-label', 'Next services');
            
            navContainer.appendChild(prevBtn);
            navContainer.appendChild(nextBtn);

            // Insert nav container into the *new* main container, before the wrapper
            carouselContainer.insertBefore(navContainer, wrapper);
            
            // Create indicators
            const indicatorsContainer = document.createElement('div');
            indicatorsContainer.className = 'carousel-indicators';
            
            for (let i = 0; i < totalSlides; i++) {
                const indicator = document.createElement('div');
                indicator.className = 'carousel-indicator';
                if (i === 1) indicator.classList.add('active');
                indicator.setAttribute('data-slide', i);
                indicator.setAttribute('aria-label', `Go to slide ${i + 1}`);
                indicatorsContainer.appendChild(indicator);
            }
            
            // Insert indicators *after* the new main container
            carouselContainer.parentNode.insertBefore(indicatorsContainer, carouselContainer.nextSibling);

            // New logic to handle clicking on any card
            serviceCards.forEach((card, index) => {
                card.addEventListener('click', () => {
                    // Only move the carousel if the clicked card is not already the active one
                    if (index !== currentIndex) {
                        currentIndex = index;
                        updateCarousel();
                    }
                });
            });

            // Replace the old updateCarousel function with this one
            function updateCarousel() {
                if (serviceCards.length === 0) return;

                // 1. Get dimensions
                const cardWidth = serviceCards[0].offsetWidth;
                const wrapperWidth = wrapper.offsetWidth;
                const gap = 32; // 2rem from your CSS

                // 2. Calculate the total offset to the *start* of the active card
                // This is (width + gap) * index
                const offsetToCard = currentIndex * (cardWidth + gap);

                // 3. Calculate the offset needed to center *a* card
                // This is (wrapper_width / 2) - (card_width / 2)
                const centerOffset = (wrapperWidth / 2) - (cardWidth / 2);

                // 4. The new transform is the centering offset - the offset to the active card
                const newTransform = centerOffset - offsetToCard;

                servicesGrid.style.transform = `translateX(${newTransform}px)`;

                // Update active classes
                serviceCards.forEach((card, index) => {
                    card.classList.toggle('service-card-active', index === currentIndex);
                });

                // Update buttons state
                prevBtn.disabled = currentIndex === 0;
                nextBtn.disabled = currentIndex >= totalSlides - 1; // Use >=
                
                // Update indicators
                document.querySelectorAll('.carousel-indicator').forEach((indicator, index) => {
                    indicator.classList.toggle('active', index === currentIndex);
                });

                // --- START: ADDED CODE ---
                // Update the counter text
                if (counterElement) {
                    counterElement.textContent = `${currentIndex + 1} / ${totalSlides}`;
                }
                // --- END: ADDED CODE ---
            }
            
            // Navigation handlers
            prevBtn.addEventListener('click', () => {
                if (currentIndex > 0) {
                    currentIndex--;
                    updateCarousel();
                }
            });
            
            nextBtn.addEventListener('click', () => {
                if (currentIndex < totalSlides - 1) {
                    currentIndex++;
                    updateCarousel();
                }
            });
            
            // Indicator handlers
            document.querySelectorAll('.carousel-indicator').forEach(indicator => {
                indicator.addEventListener('click', (e) => {
                    currentIndex = parseInt(e.target.getAttribute('data-slide'));
                    updateCarousel();
                });
            });
            
            // Keyboard navigation
            servicesSection.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowLeft' && currentIndex > 0) {
                    currentIndex--;
                    updateCarousel();
                } else if (e.key === 'ArrowRight' && currentIndex < totalSlides - 1) {
                    currentIndex++;
                    updateCarousel();
                }
            });
            
            // Handle window resize
            let resizeTimer;
            window.addEventListener('resize', () => {
                clearTimeout(resizeTimer);
                resizeTimer = setTimeout(() => {
                    if (window.innerWidth > 768) {
                        updateCarousel();
                    }
                }, 250);
            });
            
            // Initial update
            updateCarousel();
        }
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

    // --- PRICING CALCULATOR SCRIPT (Dynamic Pricing and Progress Bar) ---
    const slider = document.getElementById('spend-slider');
    const spendValue = document.getElementById('spend-value');
    const managementFee = document.getElementById('management-fee');
    const maxSpendNotification = document.getElementById('max-spend-notification');
    // NEW: Element for the static label beneath the slider
    const maxSpendLabel = document.getElementById('max-spend-label');

    // Check if slider elements exist
    if (slider && spendValue && managementFee && maxSpendNotification && maxSpendLabel) {
        
        function formatCurrency(amount) {
            // Use Math.round to ensure clean thousands separation when sliding
            return '£' + Math.round(amount).toLocaleString('en-GB');
        }

        function calculateFees() {
            const spend = parseInt(slider.value);
            const maxSpend = parseInt(slider.getAttribute('max'));
            let calculatedFee = 0; // Initialize fee
            
            // Calculate progress percentage for the green bar
            const progress = (spend / maxSpend) * 100;
            slider.style.setProperty('--slider-progress', `${progress}%`);
            
            // --- New Tiered Fee Logic ---
            if (spend === 0) {
                // £0 spend = £0 fee
                calculatedFee = 0;
            } else if (spend >= 100 && spend <= 4000) {
                // £100 to £4,000 spend = £399 fee
                calculatedFee = 399;
            } else if (spend >= 4100 && spend <= 10000) {
                // £4,100 to £10,000 spend = 10% of the slider value, rounded
                calculatedFee = Math.round(spend * 0.10);
            } else if (spend > 0 && spend < 100) {
                // Spend between £0 and £100 defaults to the £399 tier
                calculatedFee = 399; 
            }
            // --- End Tiered Fee Logic ---

            // Set fee display
            managementFee.textContent = formatCurrency(calculatedFee) + 'pm';
            
            // Calculate spend text for the value above the slider
            let spendText = formatCurrency(spend);
            
            // Determine the max label text (for the slider-labels area)
            let maxLabelText = formatCurrency(maxSpend);
            
            if (spend === maxSpend) {
                spendText += '+pm';
                maxLabelText += '+'; // Add plus sign only when max is reached
                maxSpendNotification.classList.add('show-notification');
            } else {
                spendText += 'pm';
                // maxLabelText remains "£10,000" (from formatCurrency(maxSpend))
                maxSpendNotification.classList.remove('show-notification');
            }

            // Update displays
            spendValue.textContent = spendText;
            maxSpendLabel.textContent = maxLabelText; // Update the static label element
        }

        // --- Event Listener for Slider ---
        slider.addEventListener('input', calculateFees);

        // Initial call to set fees based on default (slider=0)
        calculateFees(); 
    }
    // --- END: PRICING CALCULATOR SCRIPT ---

    
    // --- 2. Mobile Scroll Highlight Logic (Intersection Observer) ---
    
    // Check if we are on a mobile-sized screen
    if (window.innerWidth <= 768) {
        // --- Service Cards Highlight ---
        const servicesGrid = document.querySelector('.services-grid');
        const mobileServiceCards = document.querySelectorAll('.services-grid > [class^="service-card-"]');

        if (servicesGrid && mobileServiceCards.length > 0) {
            
            const observerOptions = {
                root: servicesGrid, // The scrolling container
                rootMargin: '0px',
                threshold: 0.75 // 75% of the card must be visible
            };

            const observerCallback = (entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        // First, remove .in-view from all cards
                        mobileServiceCards.forEach(card => {
                            card.classList.remove('in-view');
                        });
                        // Then, add .in-view to the one that just came into view
                        entry.target.classList.add('in-view');
                    } else {
                        // This handles removing the class when it scrolls out
                        entry.target.classList.remove('in-view');
                    }
                });
            };

            const mobileObserver = new IntersectionObserver(observerCallback, observerOptions);

            mobileServiceCards.forEach(card => {
                mobileObserver.observe(card);
            });
        }
        
        // --- Testimonial Cards Highlight ---
        const testimonialsGrid = document.querySelector('.testimonials-grid');
        const mobileTestimonialCards = document.querySelectorAll('.testimonials-grid > [class^="testimonial-card-"]');
        
        if (testimonialsGrid && mobileTestimonialCards.length > 0) {
             const testimonialObserverOptions = {
                root: testimonialsGrid, // The scrolling container
                rootMargin: '0px',
                threshold: 0.75 // 75% of the card must be visible
            };

            const testimonialObserverCallback = (entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        // First, remove .in-view from all cards
                        mobileTestimonialCards.forEach(card => {
                            card.classList.remove('in-view');
                        });
                        // Then, add .in-view to the one that just came into view
                        entry.target.classList.add('in-view');
                    } else {
                        // This handles removing the class when it scrolls out
                        entry.target.classList.remove('in-view');
                    }
                });
            };
            
            const testimonialMobileObserver = new IntersectionObserver(testimonialObserverCallback, testimonialObserverOptions);

            mobileTestimonialCards.forEach(card => {
                testimonialMobileObserver.observe(card);
            });
        }
    }
});
